#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const DEFAULTS = {
  engine: "macos-say",
  language: "zh-CN",
  voice: null,
  rate: null,
  edgeRate: "+0%",
  edgePitch: "+0Hz",
  edgeVolume: "+0%",
  timing: "auto",
  mix: "replace",
  originalVolume: 0.18,
  narrationVolume: 1,
  padMode: "freeze",
  padBufferMs: 300,
  maxPaddingMs: 60_000,
  videoCodec: "libx264",
  videoCrf: 20,
  videoPreset: "veryfast",
  keepTemp: false
}

const PAD_MODES = new Set(["freeze", "none"])

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/add-tts-narration.mjs --video <mp4> --report <report.json> --out <mp4> [options]

Options:
  --engine <engine>       macos-say | local-system | edge-tts (default: macos-say)
  --language <locale>     zh-CN | zh-TW | en-US (default: zh-CN)
  --voice <voice>         TTS voice name
  --rate <wpm>            macOS say speech rate
  --edge-rate <value>     edge-tts rate, e.g. +0%
  --edge-pitch <value>    edge-tts pitch, e.g. +0Hz
  --edge-volume <value>   edge-tts volume, e.g. +0%
  --timing <mode>         auto | report | spread
  --mix <mode>            replace | duck | keep-original
  --pad-mode <mode>       freeze | none (default: freeze)
  --pad-buffer-ms <ms>    Buffer after each cue (default: 300)
  --max-padding-ms <ms>   Fail-fast padding limit per cue (default: 60000)
  --keep-temp             Keep temporary synthesized audio files
`)
    process.exit(0)
  }
  const args = { ...DEFAULTS }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === "--keep-temp") {
      args.keepTemp = true
      continue
    }

    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }

    args[toCamelCase(key)] = value
    index += 1
  }

  if (!args.video) throw new Error("缺少 --video <mp4/webm>")
  if (!args.report) throw new Error("缺少 --report <report.json>")
  if (!args.out) throw new Error("缺少 --out <narrated.mp4>")

  args.rate = Number(args.rate || (args.language === "en-US" ? 165 : 180))
  args.originalVolume = Number(args.originalVolume)
  args.narrationVolume = Number(args.narrationVolume)
  args.padBufferMs = Number(args.padBufferMs)
  args.maxPaddingMs = Number(args.maxPaddingMs)
  args.videoCrf = Number(args.videoCrf)
  args.voice = args.voice || defaultVoice(args.language, args.engine)

  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error("--rate 必须是正数")
  }
  if (!Number.isFinite(args.padBufferMs) || args.padBufferMs < 0) {
    throw new Error("--pad-buffer-ms 必须是非负数")
  }
  if (!Number.isFinite(args.maxPaddingMs) || args.maxPaddingMs < 0) {
    throw new Error("--max-padding-ms 必须是非负数")
  }
  if (!PAD_MODES.has(args.padMode)) {
    throw new Error(`--pad-mode 仅支持 ${[...PAD_MODES].join("/")}，收到：${args.padMode}`)
  }

  return args
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function defaultVoice(language, engine = "macos-say") {
  if (engine === "edge-tts") {
    if (language === "en-US") return "en-US-GuyNeural"
    if (language === "zh-TW") return "zh-TW-YunJheNeural"
    return "zh-CN-YunyangNeural"
  }
  if (language === "en-US") return "Samantha"
  if (language === "zh-TW") return "Meijia"
  return "Tingting"
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
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

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  return result.status === 0
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

async function probeDurationMs(filePath) {
  const probe = await ffprobeJson(filePath)
  const duration = Number(probe.format?.duration || 0)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法识别媒体时长：${filePath}`)
  }
  return Math.round(duration * 1000)
}

async function ffmpegVolumeDetect(filePath) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-"
  ])
  const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  const max = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null
  }
}

function formatVttTime(ms) {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = Math.floor(ms % 1000)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

function msToFfTime(ms) {
  return (ms / 1000).toFixed(3)
}

function normalizeNarrationText(caption) {
  if (caption?.narration === false) return null
  const text = caption?.narration || [caption?.title, caption?.body].filter(Boolean).join("。")
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/。。+/g, "。")
    .trim()
}

function buildCues(captions, videoDurationMs, timing) {
  const raw = captions
    .map((caption) => ({ caption, text: normalizeNarrationText(caption) }))
    .filter((item) => item.text)

  if (raw.length === 0) {
    throw new Error("report.captions 中没有可用于 TTS 的文案")
  }

  const hasReportTiming = raw.every(({ caption }) =>
    Number.isFinite(Number(caption.startMs)) || Number.isFinite(Number(caption.atMs))
  )
  const useReportTiming = timing === "report" || (timing === "auto" && hasReportTiming)
  const slotMs = videoDurationMs / raw.length

  const cues = raw.map(({ caption, text }, index) => {
    const requestedDuration = Number(caption.durationMs || caption.ms || 3600)
    let startMs
    let endMs

    if (useReportTiming) {
      startMs = Number(caption.startMs ?? caption.atMs ?? 0)
      endMs = Number(caption.endMs ?? startMs + requestedDuration)
    } else {
      startMs = Math.round(index * slotMs + Math.min(900, slotMs * 0.12))
      endMs = Math.round(Math.min(videoDurationMs - 250, (index + 1) * slotMs - 550))
      if (endMs <= startMs) {
        endMs = Math.min(videoDurationMs, startMs + requestedDuration)
      }
    }

    return {
      title: caption.title || "",
      body: caption.body || "",
      text,
      sourceStartMs: Math.max(0, Math.round(startMs)),
      sourceEndMs: Math.max(0, Math.round(endMs))
    }
  })

  cues.sort((a, b) => a.sourceStartMs - b.sourceStartMs)
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].sourceStartMs <= cues[i - 1].sourceStartMs) {
      throw new Error(
        `cue 时间轴错误：cue[${i}] startMs=${cues[i].sourceStartMs} 必须严格晚于 cue[${i - 1}] startMs=${cues[i - 1].sourceStartMs}`
      )
    }
  }

  return cues.map((cue, index) => ({ ...cue, index: index + 1 }))
}

function buildVtt(cues) {
  return `WEBVTT\n\n${cues
    .map(
      (cue) =>
        `${cue.index}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}`
    )
    .join("\n\n")}\n`
}

async function synthesizeWithMacosSay(cues, args, tempDir) {
  if (!commandExists("say")) {
    throw new Error("当前系统没有 macOS say 命令，无法使用 local-system TTS")
  }

  const files = []

  for (const cue of cues) {
    const textPath = path.join(tempDir, `cue-${String(cue.index).padStart(3, "0")}.txt`)
    const audioPath = path.join(tempDir, `cue-${String(cue.index).padStart(3, "0")}.aiff`)
    await writeFile(textPath, cue.text)
    await run("say", ["-v", args.voice, "-r", String(args.rate), "-f", textPath, "-o", audioPath])
    files.push(audioPath)
  }

  return files
}

async function synthesizeWithEdgeTts(cues, args, tempDir) {
  if (!commandExists("uvx")) {
    throw new Error("当前系统没有 uvx，无法使用 edge-tts。请安装 uv/uvx，或改用 --engine macos-say")
  }

  const files = []

  for (const cue of cues) {
    const stem = `cue-${String(cue.index).padStart(3, "0")}`
    const textPath = path.join(tempDir, `${stem}.txt`)
    const audioPath = path.join(tempDir, `${stem}.mp3`)
    await writeFile(textPath, cue.text)
    await run("uvx", [
      "edge-tts",
      "--voice",
      args.voice,
      "--rate",
      args.edgeRate,
      "--volume",
      args.edgeVolume,
      "--pitch",
      args.edgePitch,
      "--file",
      textPath,
      "--write-media",
      audioPath
    ])
    files.push(audioPath)
  }

  return files
}

function applyPadding(cues, audioDurationsMs, videoDurationMs, args) {
  // window 锚点：每个 cue 的 sourceStartMs，以及视频结尾
  // 每个 cue 的展示窗口 = [cue.sourceStartMs, nextCue.sourceStartMs]（或 videoDurationMs）
  const adjusted = []
  let offset = 0

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]
    const audioMs = audioDurationsMs[i]
    const windowStartMs = cue.sourceStartMs
    const windowEndMs = i + 1 < cues.length ? cues[i + 1].sourceStartMs : videoDurationMs
    const windowMs = windowEndMs - windowStartMs

    if (windowMs <= 0) {
      throw new Error(`cue[${i}] 没有有效窗口：start=${windowStartMs}ms end=${windowEndMs}ms`)
    }

    let paddingMs = 0
    if (args.padMode === "freeze") {
      const neededMs = audioMs + args.padBufferMs
      paddingMs = Math.max(0, Math.round(neededMs - windowMs))
      if (paddingMs > args.maxPaddingMs) {
        throw new Error(
          `cue[${i}] 需要的 padding=${paddingMs}ms 超过 --max-padding-ms=${args.maxPaddingMs}ms。请缩短该段文案或调高上限。`
        )
      }
    }

    const sourceEndWithinWindowMs = Math.min(cue.sourceEndMs, windowEndMs)
    const preferredEndMs = Math.min(windowEndMs + paddingMs, cue.sourceStartMs + audioMs + args.padBufferMs)
    const adjustedEndMs = Math.min(
      videoDurationMs + offset + paddingMs,
      Math.max(sourceEndWithinWindowMs + offset, preferredEndMs + offset)
    )

    adjusted.push({
      ...cue,
      startMs: cue.sourceStartMs + offset,
      endMs: adjustedEndMs,
      sourceWindowStartMs: windowStartMs,
      sourceWindowEndMs: windowEndMs,
      windowEndMs: windowEndMs + offset + paddingMs,
      audioDurationMs: audioMs,
      paddingMs,
      durationMs: Math.max(250, adjustedEndMs - (cue.sourceStartMs + offset))
    })

    offset += paddingMs
  }

  return {
    cues: adjusted,
    totalPaddingMs: offset,
    totalDurationMs: videoDurationMs + offset
  }
}

const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"

function buildFastPathFilter(cues, hasOriginalAudio, args, silentInputIndex) {
  const parts = [`[${silentInputIndex}:a]${AUDIO_FORMAT},volume=0[silent]`]
  const mixInputs = ["[silent]"]

  if (hasOriginalAudio && args.mix !== "replace") {
    const originalVolume = args.mix === "duck" ? args.originalVolume : 1
    parts.push(`[0:a]${AUDIO_FORMAT},volume=${originalVolume}[base]`)
    mixInputs.push("[base]")
  }

  for (const [index, cue] of cues.entries()) {
    const inputIndex = index + 1
    const delay = Math.max(0, cue.startMs)
    const label = `n${index}`
    parts.push(
      `[${inputIndex}:a]${AUDIO_FORMAT},adelay=${delay}|${delay},volume=${args.narrationVolume}[${label}]`
    )
    mixInputs.push(`[${label}]`)
  }

  parts.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mix]`
  )
  return parts.join(";")
}

function buildPaddedFilter(cues, hasOriginalAudio, args, silentInputIndex, videoDurationMs) {
  const parts = []
  const videoSegments = []
  const audioSegments = []
  const splitsMs = cues.map((cue) => cue.sourceWindowStartMs)
  splitsMs.push(videoDurationMs)

  let cursor = 0
  let cueIdx = 0
  for (let i = 0; i < splitsMs.length; i += 1) {
    const segmentEnd = splitsMs[i]
    if (segmentEnd <= cursor) {
      continue
    }
    const segLabel = `v${i}`
    const trimEnd = segmentEnd >= videoDurationMs ? "" : `:end=${msToFfTime(segmentEnd)}`
    parts.push(`[0:v]trim=start=${msToFfTime(cursor)}${trimEnd},setpts=PTS-STARTPTS[${segLabel}]`)

    if (hasOriginalAudio && args.mix !== "replace") {
      const aLabel = `a${i}`
      parts.push(
        `[0:a]${AUDIO_FORMAT},atrim=start=${msToFfTime(cursor)}${trimEnd ? `:end=${msToFfTime(segmentEnd)}` : ""},asetpts=PTS-STARTPTS[${aLabel}]`
      )
      audioSegments.push({ label: aLabel, padMs: 0 })
    }

    // 这一段对应 cueIdx 的窗口（如果在 cue 序列里）；最后一段是收尾，没有 padding
    let segPadMs = 0
    if (cueIdx < cues.length && cues[cueIdx].sourceWindowStartMs === cursor) {
      segPadMs = cues[cueIdx].paddingMs
      cueIdx += 1
    }

    if (segPadMs > 0) {
      parts.push(
        `[${segLabel}]tpad=stop_mode=clone:stop_duration=${msToFfTime(segPadMs)}[${segLabel}p]`
      )
      videoSegments.push(`[${segLabel}p]`)
      if (audioSegments.length > 0) {
        const last = audioSegments[audioSegments.length - 1]
        last.padMs = segPadMs
      }
    } else {
      videoSegments.push(`[${segLabel}]`)
    }

    cursor = segmentEnd
  }

  parts.push(`${videoSegments.join("")}concat=n=${videoSegments.length}:v=1:a=0[outv]`)

  const mixInputs = []
  if (hasOriginalAudio && args.mix !== "replace") {
    const concatLabels = audioSegments.map((seg) => {
      if (seg.padMs > 0) {
        const padded = `${seg.label}p`
        parts.push(`[${seg.label}]apad=pad_dur=${msToFfTime(seg.padMs)}[${padded}]`)
        return `[${padded}]`
      }
      return `[${seg.label}]`
    })
    parts.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=0:a=1[orig]`)
    const ducked = args.mix === "duck" ? args.originalVolume : 1
    parts.push(`[orig]volume=${ducked}[base]`)
    mixInputs.push("[base]")
  } else {
    parts.push(`[${silentInputIndex}:a]${AUDIO_FORMAT},volume=0[silent]`)
    mixInputs.push("[silent]")
  }

  for (const [index, cue] of cues.entries()) {
    const inputIndex = index + 1
    const delay = Math.max(0, cue.startMs)
    const label = `n${index}`
    parts.push(
      `[${inputIndex}:a]${AUDIO_FORMAT},adelay=${delay}|${delay},volume=${args.narrationVolume}[${label}]`
    )
    mixInputs.push(`[${label}]`)
  }

  parts.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mix]`
  )
  return parts.join(";")
}

async function muxNarration({
  videoPath,
  audioFiles,
  cues,
  args,
  videoDurationMs,
  totalDurationMs,
  totalPaddingMs,
  hasOriginalAudio
}) {
  const totalSeconds = totalDurationMs / 1000
  const silentInputIndex = audioFiles.length + 1
  const ffmpegArgs = ["-y", "-i", videoPath]
  for (const audioFile of audioFiles) {
    ffmpegArgs.push("-i", audioFile)
  }
  ffmpegArgs.push(
    "-f",
    "lavfi",
    "-t",
    String(totalSeconds),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100"
  )

  const usePaddedFilter = totalPaddingMs > 0
  const filter = usePaddedFilter
    ? buildPaddedFilter(cues, hasOriginalAudio, args, silentInputIndex, videoDurationMs)
    : buildFastPathFilter(cues, hasOriginalAudio, args, silentInputIndex)

  ffmpegArgs.push("-filter_complex", filter)

  if (usePaddedFilter) {
    ffmpegArgs.push(
      "-map",
      "[outv]",
      "-map",
      "[mix]",
      "-c:v",
      args.videoCodec,
      "-crf",
      String(args.videoCrf),
      "-preset",
      args.videoPreset,
      "-pix_fmt",
      "yuv420p"
    )
  } else {
    ffmpegArgs.push("-map", "0:v:0", "-map", "[mix]", "-c:v", "copy")
  }

  ffmpegArgs.push("-c:a", "aac", "-b:a", "160k", "-t", String(totalSeconds), args.out)

  await run("ffmpeg", ffmpegArgs)
  return { usePaddedFilter }
}

const args = parseArgs(process.argv.slice(2))

if (!["macos-say", "local-system", "edge-tts"].includes(args.engine)) {
  throw new Error(`当前脚本仅支持 macos-say/local-system/edge-tts，收到：${args.engine}`)
}
if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
  throw new Error("需要 ffmpeg 和 ffprobe")
}

const videoPath = path.resolve(args.video)
const reportPath = path.resolve(args.report)
const outputPath = path.resolve(args.out)
args.out = outputPath
await mkdir(path.dirname(outputPath), { recursive: true })

const report = JSON.parse(await readFile(reportPath, "utf8"))
const captions = Array.isArray(report.captions) ? report.captions : []
const videoProbe = await ffprobeJson(videoPath)
const audioProbe = await ffprobeJson(videoPath, "a").catch(() => ({ streams: [] }))
const videoDurationSeconds = Number(videoProbe.format?.duration || 0)
if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
  throw new Error("无法读取视频时长")
}
const videoDurationMs = Math.round(videoDurationSeconds * 1000)

const sourceCues = buildCues(captions, videoDurationMs, args.timing)
const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-tts-"))
const transcriptPath = outputPath.replace(/\.[^.]+$/, "-narration.vtt")
const reportOutPath = outputPath.replace(/\.[^.]+$/, "-narration-report.json")

try {
  const audioFiles =
    args.engine === "edge-tts"
      ? await synthesizeWithEdgeTts(sourceCues, args, tempDir)
      : await synthesizeWithMacosSay(sourceCues, args, tempDir)
  const audioDurationsMs = []
  for (const file of audioFiles) {
    audioDurationsMs.push(await probeDurationMs(file))
  }

  const { cues: adjustedCues, totalPaddingMs, totalDurationMs } = applyPadding(
    sourceCues,
    audioDurationsMs,
    videoDurationMs,
    args
  )
  const overflowingCues = adjustedCues.filter((cue) => cue.paddingMs > 0)

  await writeFile(transcriptPath, buildVtt(adjustedCues))

  const { usePaddedFilter } = await muxNarration({
    videoPath,
    audioFiles,
    cues: adjustedCues,
    args,
    videoDurationMs,
    totalDurationMs,
    totalPaddingMs,
    hasOriginalAudio: audioProbe.streams?.length > 0
  })

  const outputProbe = await ffprobeJson(outputPath, "a")
  if (!outputProbe.streams?.length) {
    throw new Error("输出视频没有音频流")
  }
  const outputFullProbe = await ffprobeJson(outputPath)
  const outputDurationSeconds = Number(outputFullProbe.format?.duration || 0)
  const outputDurationMs = Math.round(outputDurationSeconds * 1000)
  const expectedDurationMs = totalDurationMs
  const driftMs = Math.abs(outputDurationMs - expectedDurationMs)
  if (driftMs > Math.max(500, totalDurationMs * 0.02)) {
    throw new Error(
      `输出视频时长偏差过大：expected=${expectedDurationMs}ms actual=${outputDurationMs}ms drift=${driftMs}ms`
    )
  }
  const durationRatio = outputDurationSeconds / videoDurationSeconds
  const audioVolume = await ffmpegVolumeDetect(outputPath)
  if (audioVolume.maxVolumeDb == null || audioVolume.maxVolumeDb <= -50) {
    throw new Error(`输出音轨疑似静音：maxVolumeDb=${audioVolume.maxVolumeDb}`)
  }

  await writeFile(
    reportOutPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceVideo: videoPath,
        sourceReport: reportPath,
        outputVideo: outputPath,
        transcript: transcriptPath,
        engine: args.engine,
        language: args.language,
        voice: args.voice,
        rate: args.rate,
        timing: args.timing,
        mix: args.mix,
        padMode: args.padMode,
        padBufferMs: args.padBufferMs,
        usePaddedFilter,
        videoDurationSeconds,
        outputDurationSeconds,
        durationRatio,
        timeline: {
          sourceDurationMs: videoDurationMs,
          outputDurationMs,
          expectedDurationMs,
          totalPaddingMs,
          paddedCues: overflowingCues.length
        },
        media: {
          source: {
            durationSeconds: videoDurationSeconds,
            videoStreams: videoProbe.streams?.filter((stream) => stream.codec_type === "video") ?? [],
            audioStreams: audioProbe.streams ?? []
          },
          output: {
            durationSeconds: outputDurationSeconds,
            videoStreams: outputFullProbe.streams?.filter((stream) => stream.codec_type === "video") ?? [],
            audioStreams: outputProbe.streams ?? [],
            audioVolume
          }
        },
        cues: adjustedCues
      },
      null,
      2
    )}\n`
  )

  console.log(`已生成带解说视频：${outputPath}`)
  console.log(`已生成解说字幕：${transcriptPath}`)
  console.log(`已生成解说报告：${reportOutPath}`)
  if (overflowingCues.length > 0) {
    console.log(
      `已为 ${overflowingCues.length} 段超时 TTS 自动延长视频，总增加时长：${totalPaddingMs}ms`
    )
    for (const cue of overflowingCues) {
      console.log(
        `  - cue ${cue.index} "${cue.title || cue.text.slice(0, 20)}" padding=${cue.paddingMs}ms (audio=${cue.audioDurationMs}ms, window=${cue.sourceWindowEndMs - cue.sourceWindowStartMs}ms)`
      )
    }
  }
} finally {
  if (!args.keepTemp) {
    await rm(tempDir, { recursive: true, force: true })
  } else {
    console.log(`保留临时目录：${tempDir}`)
  }
}
