#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/embed-video-cover.mjs --video <mp4> --cover <png> --out <mp4> [options]

Options:
  --title <text>          Cover stream title metadata (default: Cover)
  --comment <text>        Cover stream comment metadata (default: Cover (front))
  --intro-duration-ms <n> Prepend the cover as real video frames for n milliseconds
  --intro-background <c>  FFmpeg pad color for cover intro (default: 0x101612)
  --narration-report <p> Shift add-tts-narration report timings when using intro
  --narration-vtt <p>    Shift narration VTT timings when using intro
  --report <path>         Write embed verification JSON report
`)
    process.exit(0)
  }

  const args = {
    video: null,
    cover: null,
    out: null,
    title: "Cover",
    comment: "Cover (front)",
    introDurationMs: 0,
    introBackground: "0x101612",
    narrationReport: null,
    narrationVtt: null,
    videoCodec: "libx264",
    videoCrf: 20,
    videoPreset: "veryfast",
    audioBitrate: "160k",
    report: null
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }

    const camelKey = toCamelCase(key)
    if (!(camelKey in args)) {
      throw new Error(`无法识别参数：${token}`)
    }
    args[camelKey] = value
    index += 1
  }

  if (!args.video) throw new Error("缺少 --video <mp4>")
  if (!args.cover) throw new Error("缺少 --cover <png>")
  if (!args.out) throw new Error("缺少 --out <mp4>")
  args.introDurationMs = Number(args.introDurationMs)
  args.videoCrf = Number(args.videoCrf)
  if (!Number.isFinite(args.introDurationMs) || args.introDurationMs < 0) {
    throw new Error("--intro-duration-ms 必须是非负数字")
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
  if (selectStreams) {
    args.push("-select_streams", selectStreams)
  }
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

function shiftNumber(value, deltaMs) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.round(number + deltaMs)) : value
}

async function shiftNarrationVtt(vttPath, introDurationMs) {
  if (!vttPath || introDurationMs <= 0) return null
  const resolved = path.resolve(vttPath)
  const original = await readFile(resolved, "utf8")
  const notePattern = /^NOTE repo-demo-recorder-cover-intro-ms: (\d+)\n\n/m
  const existingIntroMs = Number(original.match(notePattern)?.[1] || 0)
  const deltaMs = introDurationMs - existingIntroMs
  if (deltaMs === 0) {
    return { path: resolved, introDurationMs, shiftedByMs: 0 }
  }

  const withoutOldNote = original.replace(notePattern, "")
  const shifted = withoutOldNote.replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, (timestamp) => {
    const parsed = parseVttTime(timestamp)
    return parsed == null ? timestamp : formatVttTime(parsed + deltaMs)
  })
  const next = shifted.replace(/^WEBVTT\s*\n/, `WEBVTT\n\nNOTE repo-demo-recorder-cover-intro-ms: ${introDurationMs}\n\n`)
  await writeFile(resolved, next)
  return { path: resolved, introDurationMs, shiftedByMs: deltaMs }
}

async function shiftNarrationReport(reportPath, introDurationMs, finalDurationSeconds) {
  if (!reportPath || introDurationMs <= 0) return null
  const resolved = path.resolve(reportPath)
  const report = JSON.parse(await readFile(resolved, "utf8"))
  const existingIntroMs = Number(report.coverIntro?.introDurationMs || 0)
  const deltaMs = introDurationMs - existingIntroMs

  if (deltaMs !== 0) {
    for (const cue of Array.isArray(report.cues) ? report.cues : []) {
      for (const key of ["startMs", "endMs", "windowEndMs"]) {
        cue[key] = shiftNumber(cue[key], deltaMs)
      }
    }

    if (report.timeline) {
      for (const key of ["outputDurationMs", "expectedDurationMs"]) {
        report.timeline[key] = shiftNumber(report.timeline[key], deltaMs)
      }
    }
  }

  report.coverIntro = {
    introDurationMs,
    shiftedByMs: deltaMs,
    updatedAt: new Date().toISOString()
  }
  if (Number.isFinite(finalDurationSeconds) && finalDurationSeconds > 0) {
    report.outputDurationSeconds = finalDurationSeconds
    if (report.timeline) {
      report.timeline.outputDurationMs = Math.round(finalDurationSeconds * 1000)
    }
    if (report.media?.output) {
      report.media.output.durationSeconds = finalDurationSeconds
    }
  }

  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`)
  return { path: resolved, introDurationMs, shiftedByMs: deltaMs }
}

async function prependCoverIntro({ videoPath, coverPath, outputPath, sourceProbe, args }) {
  const mainVideo = mainVideoStream(sourceProbe)
  if (!mainVideo?.width || !mainVideo?.height) {
    throw new Error("无法读取主视频尺寸，不能生成封面 intro")
  }

  const introSeconds = msToSeconds(args.introDurationMs)
  const sourceDurationSeconds = Number(sourceProbe.format?.duration || 0)
  const fps = frameRate(mainVideo)
  const audioStream = firstAudioStream(sourceProbe)
  const sourceVideoLabel = `[1:${mainVideo.index}]`
  const ffmpegArgs = [
    "-y",
    "-loop",
    "1",
    "-t",
    introSeconds,
    "-i",
    coverPath,
    "-i",
    videoPath
  ]

  let sourceAudioLabel = audioStream ? `[1:${audioStream.index}]` : null
  if (!audioStream) {
    ffmpegArgs.push(
      "-f",
      "lavfi",
      "-t",
      String(sourceDurationSeconds || 1),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    )
    sourceAudioLabel = "[2:a]"
  }

  const filter = [
    `[0:v]scale=${mainVideo.width}:${mainVideo.height}:force_original_aspect_ratio=decrease,pad=${mainVideo.width}:${mainVideo.height}:(ow-iw)/2:(oh-ih)/2:color=${args.introBackground},setsar=1,fps=${fps},format=yuv420p[v0]`,
    `${sourceVideoLabel}fps=${fps},format=yuv420p[v1]`,
    `anullsrc=channel_layout=stereo:sample_rate=44100:d=${introSeconds}[a0]`,
    `${sourceAudioLabel}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1]`,
    "[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
  ].join(";")

  await run("ffmpeg", [
    ...ffmpegArgs,
    "-filter_complex",
    filter,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    args.videoCodec,
    "-crf",
    String(args.videoCrf),
    "-preset",
    args.videoPreset,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    args.audioBitrate,
    outputPath
  ])
}

const args = parseArgs(process.argv.slice(2))

if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
  throw new Error("需要 ffmpeg 和 ffprobe")
}

const videoPath = path.resolve(args.video)
const coverPath = path.resolve(args.cover)
const outputPath = path.resolve(args.out)
const reportPath = args.report ? path.resolve(args.report) : outputPath.replace(/\.[^.]+$/, "-cover-embed-report.json")
const inPlace = videoPath === outputPath
const introTempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.cover-intro-${process.pid}.mp4`)
const workOutputPath = inPlace
  ? path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.cover-tmp-${process.pid}.mp4`)
  : outputPath

await readFile(videoPath)
await readFile(coverPath)
await mkdir(path.dirname(workOutputPath), { recursive: true })

const sourceProbe = await ffprobeJson(videoPath)
let embedInputPath = videoPath
let embedSourceProbe = sourceProbe

if (args.introDurationMs > 0) {
  await prependCoverIntro({
    videoPath,
    coverPath,
    outputPath: introTempPath,
    sourceProbe,
    args
  })
  embedInputPath = introTempPath
  embedSourceProbe = await ffprobeJson(embedInputPath)
}

const sourceStreams = sourceProbe.streams ?? []
const embedStreams = embedSourceProbe.streams ?? []
const mappedSourceStreams = embedStreams.filter((stream) => !isAttachedPic(stream))
if (mappedSourceStreams.length === 0) {
  throw new Error("源视频没有可保留的媒体流")
}

const coverVideoIndex = mappedSourceStreams.filter((stream) => stream.codec_type === "video").length
const ffmpegArgs = ["-y", "-i", embedInputPath, "-i", coverPath]
for (const stream of mappedSourceStreams) {
  ffmpegArgs.push("-map", `0:${stream.index}`)
}
ffmpegArgs.push(
  "-map",
  "1:v:0",
  "-c",
  "copy",
  `-c:v:${coverVideoIndex}`,
  "png",
  `-disposition:v:${coverVideoIndex}`,
  "attached_pic",
  `-metadata:s:v:${coverVideoIndex}`,
  `title=${args.title}`,
  `-metadata:s:v:${coverVideoIndex}`,
  `comment=${args.comment}`,
  workOutputPath
)

try {
  await run("ffmpeg", ffmpegArgs)
  if (inPlace) {
    await rename(workOutputPath, outputPath)
  }
} catch (error) {
  if (inPlace) {
    await rm(workOutputPath, { force: true })
  }
  throw error
} finally {
  if (args.introDurationMs > 0) {
    await rm(introTempPath, { force: true })
  }
}

const outputProbe = await ffprobeJson(outputPath)
const sourceMainVideo = mainVideoStream(sourceProbe)
const outputMainVideo = mainVideoStream(outputProbe)
const coverStreams = (outputProbe.streams ?? []).filter(isAttachedPic)
const audioStreams = (outputProbe.streams ?? []).filter((stream) => stream.codec_type === "audio")
const outputDurationSeconds = Number(outputProbe.format?.duration || 0)
const shiftedNarrationVtt = await shiftNarrationVtt(args.narrationVtt, args.introDurationMs)
const shiftedNarrationReport = await shiftNarrationReport(
  args.narrationReport,
  args.introDurationMs,
  outputDurationSeconds
)

if (!outputMainVideo) {
  throw new Error("输出视频没有主 video stream")
}
if (sourceMainVideo && (outputMainVideo.width !== sourceMainVideo.width || outputMainVideo.height !== sourceMainVideo.height)) {
  throw new Error(
    `主视频尺寸被意外改变：source=${sourceMainVideo.width}x${sourceMainVideo.height} output=${outputMainVideo.width}x${outputMainVideo.height}`
  )
}
if (coverStreams.length === 0) {
  throw new Error("输出 MP4 没有 attached_pic 封面流")
}

const summary = {
  createdAt: new Date().toISOString(),
  sourceVideo: videoPath,
  cover: coverPath,
  outputVideo: outputPath,
  visibleIntro: {
    enabled: args.introDurationMs > 0,
    introDurationMs: args.introDurationMs,
    introBackground: args.introBackground
  },
  shiftedNarrationVtt,
  shiftedNarrationReport,
  sourceStreams: sourceStreams.length,
  mappedSourceStreams: mappedSourceStreams.length,
  mainVideo: outputMainVideo
    ? {
        codec: outputMainVideo.codec_name,
        width: outputMainVideo.width,
        height: outputMainVideo.height,
        frameRate: outputMainVideo.r_frame_rate
      }
    : null,
  audioStreams: audioStreams.length,
  coverArtStreams: coverStreams.map((stream) => ({
    index: stream.index,
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    attachedPic: isAttachedPic(stream),
    tags: stream.tags ?? {}
  })),
  format: {
    durationSeconds: outputDurationSeconds,
    sizeBytes: Number(outputProbe.format?.size || 0)
  }
}

await mkdir(path.dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`)

console.log(`已嵌入视频封面：${outputPath}`)
console.log(`已生成封面嵌入报告：${reportPath}`)
