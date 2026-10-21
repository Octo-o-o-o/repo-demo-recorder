#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/trim-video-gap.mjs --video <mp4> --out <mp4> --remove-start-ms <n> --remove-end-ms <n> [options]

Options:
  --cover <png>             Re-embed this PNG as MP4 attached_pic cover art
  --narration-report <path> Shift add-tts-narration report timings after the removed range
  --narration-vtt <path>    Shift narration VTT timings after the removed range
  --report <path>           Write trim verification JSON report
  --video-codec <codec>     Video codec for the trimmed main stream (default: libx264)
  --video-crf <n>           Video CRF for the trimmed main stream (default: 20)
  --video-preset <preset>   Encoder preset (default: veryfast)
  --audio-bitrate <rate>    AAC bitrate (default: 160k)
`)
    process.exit(0)
  }

  const args = {
    video: null,
    out: null,
    cover: null,
    removeStartMs: null,
    removeEndMs: null,
    narrationReport: null,
    narrationVtt: null,
    report: null,
    videoCodec: "libx264",
    videoCrf: 20,
    videoPreset: "veryfast",
    audioBitrate: "160k"
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = toCamelCase(token.slice(2))
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }
    if (!(key in args)) {
      throw new Error(`无法识别参数：${token}`)
    }
    args[key] = value
    index += 1
  }

  if (!args.video) throw new Error("缺少 --video <mp4>")
  if (!args.out) throw new Error("缺少 --out <mp4>")
  if (args.removeStartMs == null) throw new Error("缺少 --remove-start-ms <ms>")
  if (args.removeEndMs == null) throw new Error("缺少 --remove-end-ms <ms>")
  args.removeStartMs = Number(args.removeStartMs)
  args.removeEndMs = Number(args.removeEndMs)
  args.videoCrf = Number(args.videoCrf)
  if (!Number.isFinite(args.removeStartMs) || args.removeStartMs < 0) {
    throw new Error("--remove-start-ms 必须是非负数字")
  }
  if (!Number.isFinite(args.removeEndMs) || args.removeEndMs <= args.removeStartMs) {
    throw new Error("--remove-end-ms 必须大于 --remove-start-ms")
  }
  if (!Number.isFinite(args.videoCrf) || args.videoCrf < 0) {
    throw new Error("--video-crf 必须是非负数字")
  }
  return args
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  return result.status === 0
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`))
      }
    })
  })
}

async function ffprobeJson(filePath, selectStreams) {
  const args = ["-v", "error", "-print_format", "json"]
  if (selectStreams) args.push("-select_streams", selectStreams)
  args.push("-show_streams", "-show_format", filePath)
  const { stdout } = await run("ffprobe", args)
  return JSON.parse(stdout)
}

function isAttachedPic(stream) {
  return Number(stream?.disposition?.attached_pic || 0) === 1
}

function mainVideoStream(probe) {
  return probe.streams?.find((stream) => stream.codec_type === "video" && !isAttachedPic(stream)) ?? null
}

function firstAudioStream(probe) {
  return probe.streams?.find((stream) => stream.codec_type === "audio") ?? null
}

function frameRate(stream) {
  const raw = stream?.avg_frame_rate && stream.avg_frame_rate !== "0/0" ? stream.avg_frame_rate : stream?.r_frame_rate
  if (!raw || raw === "0/0") return "25"
  const [numerator, denominator] = String(raw).split("/").map(Number)
  if (!Number.isFinite(numerator) || numerator <= 0) return "25"
  if (!Number.isFinite(denominator) || denominator <= 0) return String(numerator)
  return String(Math.min(60, Math.max(1, numerator / denominator)))
}

function msToSeconds(ms) {
  return (ms / 1000).toFixed(3)
}

function parseVttTime(value) {
  const match = String(value).match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (!match) return null
  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(match[4])
  )
}

function formatVttTime(ms) {
  const value = Math.max(0, Math.round(ms))
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const millis = Math.floor(value % 1000)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

function shiftAcrossRemovedRange(value, removeStartMs, removeEndMs) {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  if (number >= removeEndMs) return Math.max(0, Math.round(number - (removeEndMs - removeStartMs)))
  if (number > removeStartMs) return Math.round(removeStartMs)
  return Math.round(number)
}

async function shiftNarrationVtt(vttPath, removeStartMs, removeEndMs) {
  if (!vttPath) return null
  const resolved = path.resolve(vttPath)
  const original = await readFile(resolved, "utf8")
  const removedMs = removeEndMs - removeStartMs
  const shifted = original.replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, (timestamp) => {
    const parsed = parseVttTime(timestamp)
    return parsed == null ? timestamp : formatVttTime(shiftAcrossRemovedRange(parsed, removeStartMs, removeEndMs))
  })
  // 每次 trim 都追加一条 NOTE，便于审计多次 trim 的历史
  const note = `NOTE repo-demo-recorder-removed-gap-ms: ${removeStartMs}-${removeEndMs} (${removedMs})`
  const lines = shifted.split("\n")
  if (lines[0] !== "WEBVTT") {
    throw new Error(`narration-vtt 文件首行不是 WEBVTT：${resolved}`)
  }
  let insertIndex = 1
  while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex += 1
  while (
    insertIndex < lines.length &&
    lines[insertIndex].startsWith("NOTE repo-demo-recorder-removed-gap-ms:")
  ) {
    insertIndex += 1
    while (insertIndex < lines.length && lines[insertIndex].trim() !== "") insertIndex += 1
    while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex += 1
  }
  lines.splice(insertIndex, 0, note, "")
  const next = lines.join("\n")
  await writeFile(resolved, next)
  return { path: resolved, removeStartMs, removeEndMs, removedMs }
}

async function shiftNarrationReport(reportPath, removeStartMs, removeEndMs, finalDurationSeconds) {
  if (!reportPath) return null
  const resolved = path.resolve(reportPath)
  const report = JSON.parse(await readFile(resolved, "utf8"))
  const removedMs = removeEndMs - removeStartMs

  for (const cue of Array.isArray(report.cues) ? report.cues : []) {
    for (const key of ["startMs", "endMs", "windowEndMs"]) {
      cue[key] = shiftAcrossRemovedRange(cue[key], removeStartMs, removeEndMs)
    }
    cue.durationMs = Math.max(250, Number(cue.endMs || 0) - Number(cue.startMs || 0))
  }

  if (report.timeline) {
    for (const key of ["outputDurationMs", "expectedDurationMs"]) {
      const value = Number(report.timeline[key])
      if (Number.isFinite(value)) report.timeline[key] = Math.max(0, Math.round(value - removedMs))
    }
  }

  report.removedGaps = Array.isArray(report.removedGaps) ? report.removedGaps : []
  report.removedGaps.push({
    removeStartMs,
    removeEndMs,
    removedMs,
    updatedAt: new Date().toISOString()
  })
  if (Number.isFinite(finalDurationSeconds) && finalDurationSeconds > 0) {
    report.outputDurationSeconds = finalDurationSeconds
    if (report.timeline) report.timeline.outputDurationMs = Math.round(finalDurationSeconds * 1000)
    if (report.media?.output) report.media.output.durationSeconds = finalDurationSeconds
  }

  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`)
  return { path: resolved, removeStartMs, removeEndMs, removedMs }
}

async function trimGap({ videoPath, coverPath, outputPath, probe, args }) {
  const mainVideo = mainVideoStream(probe)
  if (!mainVideo) throw new Error("源视频没有主 video stream")
  const audioStream = firstAudioStream(probe)
  const hasAudio = Boolean(audioStream)
  // 若用户没传 --cover 但源视频里已嵌入封面流，则保留它（沿用源 PNG，避免静默丢失封面）。
  // 显式传入 --cover 时优先用用户提供的封面。
  const existingCoverStreams = (probe.streams ?? []).filter(isAttachedPic)
  const preservedCoverStream = !coverPath && existingCoverStreams.length > 0 ? existingCoverStreams[0] : null
  const sourceVideoLabel = `[0:${mainVideo.index}]`
  const sourceAudioLabel = audioStream ? `[0:${audioStream.index}]` : null
  const removeStart = msToSeconds(args.removeStartMs)
  const removeEnd = msToSeconds(args.removeEndMs)
  const fps = frameRate(mainVideo)

  const ffmpegArgs = ["-y", "-i", videoPath]
  if (coverPath) ffmpegArgs.push("-i", coverPath)

  const videoSegments = []
  const audioSegments = []
  const parts = []

  if (args.removeStartMs > 0) {
    parts.push(`${sourceVideoLabel}trim=start=0:end=${removeStart},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v0]`)
    videoSegments.push("[v0]")
    if (hasAudio) {
      parts.push(
        `${sourceAudioLabel}atrim=start=0:end=${removeStart},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0]`
      )
      audioSegments.push("[a0]")
    }
  }

  parts.push(`${sourceVideoLabel}trim=start=${removeEnd},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v1]`)
  videoSegments.push("[v1]")
  if (hasAudio) {
    parts.push(
      `${sourceAudioLabel}atrim=start=${removeEnd},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1]`
    )
    audioSegments.push("[a1]")
  }

  if (hasAudio) {
    const concatInputs = videoSegments.map((segment, index) => `${segment}${audioSegments[index]}`).join("")
    parts.push(`${concatInputs}concat=n=${videoSegments.length}:v=1:a=1[outv][outa]`)
  } else {
    parts.push(`${videoSegments.join("")}concat=n=${videoSegments.length}:v=1:a=0[outv]`)
  }

  ffmpegArgs.push("-filter_complex", parts.join(";"), "-map", "[outv]")
  if (hasAudio) ffmpegArgs.push("-map", "[outa]")
  if (coverPath) {
    ffmpegArgs.push("-map", "1:v:0")
  } else if (preservedCoverStream) {
    ffmpegArgs.push("-map", `0:${preservedCoverStream.index}`)
  }
  ffmpegArgs.push(
    "-c:v:0",
    args.videoCodec,
    "-crf",
    String(args.videoCrf),
    "-preset",
    args.videoPreset,
    "-pix_fmt",
    "yuv420p"
  )
  if (hasAudio) ffmpegArgs.push("-c:a", "aac", "-b:a", args.audioBitrate)
  if (coverPath) {
    ffmpegArgs.push(
      "-c:v:1",
      "png",
      "-disposition:v:1",
      "attached_pic",
      "-metadata:s:v:1",
      "title=Cover",
      "-metadata:s:v:1",
      "comment=Cover (front)"
    )
  } else if (preservedCoverStream) {
    const existingTitle = preservedCoverStream.tags?.title || "Cover"
    const existingComment = preservedCoverStream.tags?.comment || "Cover (front)"
    ffmpegArgs.push(
      "-c:v:1",
      "copy",
      "-disposition:v:1",
      "attached_pic",
      "-metadata:s:v:1",
      `title=${existingTitle}`,
      "-metadata:s:v:1",
      `comment=${existingComment}`
    )
  }
  ffmpegArgs.push(outputPath)

  await run("ffmpeg", ffmpegArgs)
}

const args = parseArgs(process.argv.slice(2))

if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
  throw new Error("需要 ffmpeg 和 ffprobe")
}

const videoPath = path.resolve(args.video)
const outputPath = path.resolve(args.out)
const coverPath = args.cover ? path.resolve(args.cover) : null
const inPlace = videoPath === outputPath
const workOutputPath = inPlace
  ? path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.gap-trim-${process.pid}.mp4`)
  : outputPath
const reportPath = args.report ? path.resolve(args.report) : outputPath.replace(/\.[^.]+$/, "-gap-trim-report.json")

await readFile(videoPath)
if (coverPath) await readFile(coverPath)
await mkdir(path.dirname(workOutputPath), { recursive: true })

const sourceProbe = await ffprobeJson(videoPath)
const sourceDurationMs = Math.round(Number(sourceProbe.format?.duration || 0) * 1000)
if (args.removeEndMs >= sourceDurationMs) {
  throw new Error(`--remove-end-ms 超过视频时长：removeEnd=${args.removeEndMs}ms duration=${sourceDurationMs}ms`)
}

try {
  await trimGap({ videoPath, coverPath, outputPath: workOutputPath, probe: sourceProbe, args })
  if (inPlace) await rename(workOutputPath, outputPath)
} catch (error) {
  if (inPlace) await rm(workOutputPath, { force: true })
  throw error
}

const outputProbe = await ffprobeJson(outputPath)
const outputDurationSeconds = Number(outputProbe.format?.duration || 0)
const shiftedNarrationVtt = await shiftNarrationVtt(args.narrationVtt, args.removeStartMs, args.removeEndMs)
const shiftedNarrationReport = await shiftNarrationReport(
  args.narrationReport,
  args.removeStartMs,
  args.removeEndMs,
  outputDurationSeconds
)
const coverArtStreams = (outputProbe.streams ?? []).filter(isAttachedPic)
const audioStreams = (outputProbe.streams ?? []).filter((stream) => stream.codec_type === "audio")
const sourceMainVideo = mainVideoStream(sourceProbe)
const outputMainVideo = mainVideoStream(outputProbe)

if (!outputMainVideo) {
  throw new Error("输出视频没有主 video stream")
}
if (
  sourceMainVideo &&
  (outputMainVideo.width !== sourceMainVideo.width || outputMainVideo.height !== sourceMainVideo.height)
) {
  throw new Error(
    `主视频尺寸被意外改变：source=${sourceMainVideo.width}x${sourceMainVideo.height} output=${outputMainVideo.width}x${outputMainVideo.height}`
  )
}

const summary = {
  createdAt: new Date().toISOString(),
  sourceVideo: videoPath,
  outputVideo: outputPath,
  cover: coverPath,
  removedGap: {
    removeStartMs: args.removeStartMs,
    removeEndMs: args.removeEndMs,
    removedMs: args.removeEndMs - args.removeStartMs
  },
  shiftedNarrationVtt,
  shiftedNarrationReport,
  media: {
    sourceDurationSeconds: Number(sourceProbe.format?.duration || 0),
    outputDurationSeconds,
    mainVideo: outputMainVideo
      ? {
          codec: outputMainVideo.codec_name,
          width: outputMainVideo.width,
          height: outputMainVideo.height,
          frameRate: outputMainVideo.r_frame_rate
        }
      : null,
    audioStreams: audioStreams.length,
    coverArtStreams: coverArtStreams.map((stream) => ({
      index: stream.index,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      attachedPic: isAttachedPic(stream),
      tags: stream.tags ?? {}
    }))
  }
}

await mkdir(path.dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`)

console.log(`已删除视频空白/间隔片段：${outputPath}`)
console.log(`已生成空白裁剪报告：${reportPath}`)
