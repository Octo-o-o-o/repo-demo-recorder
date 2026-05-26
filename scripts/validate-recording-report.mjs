#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/validate-recording-report.mjs <report.json> [options]

Options:
  --video <path>                    Final output video
  --source-video <path>             Source video before narration/muxing
  --narration-report <path>         Narration timing report
  --require-audio                   Require a non-silent audio stream
  --require-cover-art               Require an MP4 attached_pic cover stream
  --expect-width <px>               Expected video width
  --expect-height <px>              Expected video height
  --allow-response <text>           Allow matching response error text
  --allow-console <text>            Allow matching console error text
  --allow-page-errors               Do not fail on pageErrors
  --write-media-report <path>       Write JSON media validation summary
  --write-frame-review <dir>        Extract cue transition frames and contact sheet
  --frame-review-offsets-ms <list>  Comma-separated offsets, default -220,-80,80,220
`)
    process.exit(0)
  }
  const args = {
    reportPath: null,
    maxOverflow: 0,
    allowResponse: [],
    allowConsole: [],
    allowPageErrors: false,
    video: null,
    sourceVideo: null,
    narrationReport: null,
    requireAudio: false,
    requireCoverArt: false,
    minDurationRatio: 0.98,
    maxDurationRatio: null,
    expectedDurationToleranceMs: 500,
    expectedDurationToleranceRatio: 0.02,
    minAudioMaxDb: -50,
    expectWidth: null,
    expectHeight: null,
    writeMediaReport: null,
    writeFrameReview: null,
    frameReviewMaxFrames: 80,
    frameReviewOffsetsMs: [-220, -80, 80, 220]
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith("--") && !args.reportPath) {
      args.reportPath = token
      continue
    }

    if (token === "--allow-page-errors") {
      args.allowPageErrors = true
      continue
    }

    if (token === "--require-audio") {
      args.requireAudio = true
      continue
    }

    if (token === "--require-cover-art") {
      args.requireCoverArt = true
      continue
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }

    if (key === "max-overflow") {
      args.maxOverflow = Number(value)
    } else if (key === "allow-response") {
      args.allowResponse.push(value)
    } else if (key === "allow-console") {
      args.allowConsole.push(value)
    } else if (key === "video") {
      args.video = value
    } else if (key === "source-video") {
      args.sourceVideo = value
    } else if (key === "narration-report") {
      args.narrationReport = value
    } else if (key === "min-duration-ratio") {
      args.minDurationRatio = Number(value)
    } else if (key === "max-duration-ratio") {
      args.maxDurationRatio = Number(value)
    } else if (key === "expected-duration-tolerance-ms") {
      args.expectedDurationToleranceMs = Number(value)
    } else if (key === "expected-duration-tolerance-ratio") {
      args.expectedDurationToleranceRatio = Number(value)
    } else if (key === "min-audio-max-db") {
      args.minAudioMaxDb = Number(value)
    } else if (key === "expect-width") {
      args.expectWidth = Number(value)
    } else if (key === "expect-height") {
      args.expectHeight = Number(value)
    } else if (key === "write-media-report") {
      args.writeMediaReport = value
    } else if (key === "write-frame-review") {
      args.writeFrameReview = value
    } else if (key === "frame-review-max-frames") {
      args.frameReviewMaxFrames = Number(value)
    } else if (key === "frame-review-offsets-ms") {
      args.frameReviewOffsetsMs = String(value)
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item))
    } else {
      throw new Error(`无法识别参数：${token}`)
    }

    index += 1
  }

  if (!args.reportPath) {
    throw new Error("用法：node validate-recording-report.mjs <report.json> [--video narrated.mp4] [--narration-report narration.json] [--source-video original.mp4] [--allow-response text] [--allow-console text]")
  }

  if (!Number.isFinite(args.maxOverflow) || args.maxOverflow < 0) {
    throw new Error("--max-overflow 必须是非负数字")
  }
  if (args.maxDurationRatio != null && (!Number.isFinite(args.maxDurationRatio) || args.maxDurationRatio < args.minDurationRatio)) {
    throw new Error("--max-duration-ratio 必须 >= --min-duration-ratio")
  }
  if (!Number.isFinite(args.expectedDurationToleranceMs) || args.expectedDurationToleranceMs < 0) {
    throw new Error("--expected-duration-tolerance-ms 必须是非负数字")
  }
  if (!Number.isFinite(args.expectedDurationToleranceRatio) || args.expectedDurationToleranceRatio < 0) {
    throw new Error("--expected-duration-tolerance-ratio 必须是非负数字")
  }
  if (!Number.isFinite(args.frameReviewMaxFrames) || args.frameReviewMaxFrames < 1) {
    throw new Error("--frame-review-max-frames 必须是正数字")
  }
  if (!args.frameReviewOffsetsMs.length) {
    throw new Error("--frame-review-offsets-ms 至少需要一个毫秒偏移")
  }

  return args
}

function ffprobe(filePath, selectStreams) {
  const commandArgs = ["-v", "error", "-print_format", "json"]
  if (selectStreams) {
    commandArgs.push("-select_streams", selectStreams)
  }
  commandArgs.push("-show_streams", "-show_format", filePath)

  const result = spawnSync("ffprobe", commandArgs, { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe 失败：${filePath}`)
  }
  return JSON.parse(result.stdout)
}

function ffmpegVolumeDetect(filePath) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", filePath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg volumedetect 失败：${filePath}`)
  }
  const stderr = result.stderr || ""
  const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  const max = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null
  }
}

function runFfmpeg(commandArgs) {
  const result = spawnSync("ffmpeg", commandArgs, { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg 失败：${commandArgs.join(" ")}`)
  }
}

function firstVideoStream(probe) {
  return (
    probe.streams?.find(
      (stream) => stream.codec_type === "video" && Number(stream.disposition?.attached_pic || 0) !== 1
    ) ??
    probe.streams?.find((stream) => stream.codec_type === "video") ??
    probe.streams?.[0] ??
    null
  )
}

function attachedPictureStreams(probe) {
  return (probe.streams ?? []).filter((stream) => Number(stream.disposition?.attached_pic || 0) === 1)
}

function asText(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (value.url || value.status || value.method) {
    return [value.method, value.status, value.url].filter(Boolean).join(" ")
  }
  return JSON.stringify(value)
}

function allowed(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern))
}

function sanitizeFilePart(value) {
  return String(value || "cue")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "cue"
}

async function writeFrameReview(report, args) {
  if (!args.writeFrameReview) return null
  const videoPath = args.sourceVideo || args.video
  if (!videoPath) {
    throw new Error("--write-frame-review 需要同时提供 --source-video 或 --video")
  }

  const outputDir = path.resolve(args.writeFrameReview)
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  const captions = Array.isArray(report.captions) ? report.captions : []
  const samples = []
  for (const [cueIndex, cue] of captions.entries()) {
    const title = sanitizeFilePart(cue.title || cue.kind || `cue-${cueIndex + 1}`)
    const boundaries = [
      { label: "start", value: Number(cue.startMs ?? cue.atMs ?? 0) },
      { label: "end", value: Number(cue.endMs ?? (cue.startMs || cue.atMs || 0) + (cue.durationMs || 0)) }
    ].filter((item) => Number.isFinite(item.value) && item.value >= 0)

    for (const boundary of boundaries) {
      for (const offset of args.frameReviewOffsetsMs) {
        const ms = Math.max(0, Math.round(boundary.value + offset))
        const offsetLabel = offset < 0 ? `minus${Math.abs(offset)}` : `plus${offset}`
        samples.push({
          cueIndex: cueIndex + 1,
          kind: cue.kind || "caption",
          title: cue.title || "",
          boundary: boundary.label,
          offsetMs: offset,
          atMs: ms,
          file: path.join(
            outputDir,
            `${String(samples.length + 1).padStart(3, "0")}-${String(cueIndex + 1).padStart(2, "0")}-${title}-${boundary.label}-${offsetLabel}.png`
          )
        })
      }
    }
  }

  const selectedSamples = samples.slice(0, args.frameReviewMaxFrames)
  for (const sample of selectedSamples) {
    runFfmpeg([
      "-y",
      "-ss",
      (sample.atMs / 1000).toFixed(3),
      "-i",
      path.resolve(videoPath),
      "-frames:v",
      "1",
      sample.file
    ])
  }

  let contactSheet = null
  if (selectedSamples.length > 0) {
    const columns = Math.min(4, selectedSamples.length)
    const rows = Math.ceil(selectedSamples.length / columns)
    contactSheet = path.join(outputDir, "contact-sheet.png")
    runFfmpeg([
      "-y",
      "-pattern_type",
      "glob",
      "-i",
      path.join(outputDir, "[0-9][0-9][0-9]-*.png"),
      "-filter_complex",
      `scale=360:-1,tile=${columns}x${rows}:padding=8:margin=8:color=white`,
      contactSheet
    ])
  }

  const review = {
    video: path.resolve(videoPath),
    outputDir,
    contactSheet,
    sampleCount: selectedSamples.length,
    totalCandidateFrames: samples.length,
    offsetsMs: args.frameReviewOffsetsMs,
    samples: selectedSamples.map((sample) => ({
      ...sample,
      file: path.relative(process.cwd(), sample.file)
    }))
  }
  await writeFile(path.join(outputDir, "frame-review.json"), `${JSON.stringify(review, null, 2)}\n`)
  return review
}

function collectFailures(report, args) {
  const failures = []
  const media = {}
  const steps = Array.isArray(report.steps) ? report.steps : []
  const pageErrors = Array.isArray(report.pageErrors) ? report.pageErrors : []
  const responseErrors = Array.isArray(report.responseErrors) ? report.responseErrors : []
  const consoleMessages = Array.isArray(report.consoleMessages) ? report.consoleMessages : []

  for (const [index, step] of steps.entries()) {
    if (step?.highlightVisible) {
      failures.push(`高亮滞留：steps[${index}] ${step.label || ""}`)
    }

    const overflow = Number(step?.overflow || 0)
    if (overflow > args.maxOverflow) {
      failures.push(`横向溢出：steps[${index}] ${step.label || ""} overflow=${overflow}`)
    }
  }

  if (!args.allowPageErrors && pageErrors.length > 0) {
    failures.push(`pageErrors 非空：${pageErrors.length} 条`)
  }

  for (const item of responseErrors) {
    const text = asText(item)
    if (!allowed(text, args.allowResponse)) {
      failures.push(`未允许的 response error：${text}`)
    }
  }

  for (const item of consoleMessages) {
    const type = item?.type || "unknown"
    const text = asText(item?.text || item)
    if (type === "error" && !allowed(text, args.allowConsole)) {
      failures.push(`未允许的 console error：${text}`)
    }
  }

  if (report.qualityGates?.requireApiSuccess && !report.apiAssertions?.some((item) => item.ok)) {
    failures.push("场景要求 API 成功断言，但 report.apiAssertions 中没有 ok=true")
  }

  if (report.qualityGates?.requireDbAssertions && !report.dbAssertions?.some((item) => item.ok)) {
    failures.push("场景要求 DB 落库断言，但 report.dbAssertions 中没有 ok=true")
  }

  if (args.video || args.requireAudio || args.requireCoverArt) {
    if (!args.video) {
      failures.push("要求媒体校验但缺少 --video")
    } else {
      try {
        const resolvedVideo = path.resolve(args.video)
        const fullProbe = ffprobe(resolvedVideo)
        const audioProbe = ffprobe(resolvedVideo, "a")
        const videoStream = firstVideoStream(fullProbe)
        const coverArtStreams = attachedPictureStreams(fullProbe)
        media.output = {
          path: resolvedVideo,
          durationSeconds: Number(fullProbe.format?.duration || 0),
          sizeBytes: Number(fullProbe.format?.size || 0),
          video: videoStream
            ? {
                codec: videoStream.codec_name,
                width: videoStream.width,
                height: videoStream.height,
                frameRate: videoStream.r_frame_rate
              }
            : null,
          audioStreams: audioProbe.streams?.length ?? 0,
          coverArtStreams: coverArtStreams.map((stream) => ({
            index: stream.index,
            codec: stream.codec_name,
            width: stream.width,
            height: stream.height,
            attachedPic: Number(stream.disposition?.attached_pic || 0) === 1,
            tags: stream.tags ?? {}
          }))
        }
        if (!videoStream) {
          failures.push("视频没有 video stream")
        }
        if (args.expectWidth && videoStream?.width !== args.expectWidth) {
          failures.push(`视频宽度不符合预期：expected=${args.expectWidth} actual=${videoStream?.width}`)
        }
        if (args.expectHeight && videoStream?.height !== args.expectHeight) {
          failures.push(`视频高度不符合预期：expected=${args.expectHeight} actual=${videoStream?.height}`)
        }
        if (!audioProbe.streams?.length) {
          failures.push("视频没有音频流")
        } else {
          const volume = ffmpegVolumeDetect(resolvedVideo)
          media.output.audioVolume = volume
          if (volume.maxVolumeDb == null || volume.maxVolumeDb <= args.minAudioMaxDb) {
            failures.push(`音频疑似静音：maxVolumeDb=${volume.maxVolumeDb}, threshold>${args.minAudioMaxDb}`)
          }
        }
        if (args.requireCoverArt && coverArtStreams.length === 0) {
          failures.push("视频没有 attached_pic 封面流")
        }
      } catch (error) {
        failures.push(`媒体流校验失败：${error.message}`)
      }
    }
  }

  if (args.video && args.sourceVideo) {
    try {
      const outputProbe = ffprobe(path.resolve(args.video))
      const sourceProbe = ffprobe(path.resolve(args.sourceVideo))
      const outputDuration = Number(outputProbe.format?.duration || 0)
      const sourceDuration = Number(sourceProbe.format?.duration || 0)
      media.source = {
        path: path.resolve(args.sourceVideo),
        durationSeconds: sourceDuration,
        sizeBytes: Number(sourceProbe.format?.size || 0),
        video: firstVideoStream(sourceProbe)
      }
      media.durationRatio = sourceDuration ? outputDuration / sourceDuration : null
      if (!outputDuration || !sourceDuration) {
        failures.push("无法读取视频时长")
      } else {
        const ratio = outputDuration / sourceDuration
        if (ratio < args.minDurationRatio) {
          failures.push(`视频时长过短：output=${outputDuration}s source=${sourceDuration}s ratio=${ratio.toFixed(3)} < ${args.minDurationRatio}`)
        }
        if (args.maxDurationRatio != null && ratio > args.maxDurationRatio) {
          failures.push(`视频时长过长：output=${outputDuration}s source=${sourceDuration}s ratio=${ratio.toFixed(3)} > ${args.maxDurationRatio}`)
        }
      }
    } catch (error) {
      failures.push(`视频时长校验失败：${error.message}`)
    }
  }

  if (args.narrationReport) {
    try {
      const narrationReportPath = path.resolve(args.narrationReport)
      const narrationReport = JSON.parse(readFileSync(narrationReportPath, "utf8"))
      const timeline = narrationReport.timeline || {}
      const expected = Number(timeline.expectedDurationMs)
      const padMode = narrationReport.padMode || (timeline.totalPaddingMs > 0 ? "freeze" : "none")
      media.narration = {
        path: narrationReportPath,
        padMode,
        padBufferMs: narrationReport.padBufferMs ?? null,
        usePaddedFilter: Boolean(narrationReport.usePaddedFilter),
        sourceDurationMs: timeline.sourceDurationMs ?? null,
        expectedDurationMs: Number.isFinite(expected) ? expected : null,
        totalPaddingMs: timeline.totalPaddingMs ?? 0,
        paddedCues: timeline.paddedCues ?? 0
      }

      if (args.video && Number.isFinite(expected)) {
        const outputProbe = ffprobe(path.resolve(args.video))
        const outputDurationMs = Math.round(Number(outputProbe.format?.duration || 0) * 1000)
        const driftMs = Math.abs(outputDurationMs - expected)
        const tolerance = Math.max(args.expectedDurationToleranceMs, expected * args.expectedDurationToleranceRatio)
        media.narration.outputDurationMs = outputDurationMs
        media.narration.driftMs = driftMs
        media.narration.toleranceMs = Math.round(tolerance)
        if (driftMs > tolerance) {
          failures.push(`narration-report 时长偏差过大：expected=${expected}ms actual=${outputDurationMs}ms drift=${driftMs}ms > ${Math.round(tolerance)}ms`)
        }
      }
    } catch (error) {
      failures.push(`narration-report 校验失败：${error.message}`)
    }
  }

  return { failures, media }
}

const args = parseArgs(process.argv.slice(2))
const reportPath = path.resolve(args.reportPath)
const report = JSON.parse(await readFile(reportPath, "utf8"))
const { failures, media } = collectFailures(report, args)

if (args.writeFrameReview) {
  try {
    media.frameReview = await writeFrameReview(report, args)
  } catch (error) {
    failures.push(`frame review 生成失败：${error.message}`)
  }
}

const summary = {
  report: path.relative(process.cwd(), reportPath),
  scenario: report.scenario || report.name || "unknown",
  steps: Array.isArray(report.steps) ? report.steps.length : 0,
  captions: Array.isArray(report.captions) ? report.captions.length : 0,
  pageErrors: Array.isArray(report.pageErrors) ? report.pageErrors.length : 0,
  responseErrors: Array.isArray(report.responseErrors) ? report.responseErrors.length : 0,
  failures: failures.length,
  media
}

console.log(JSON.stringify(summary, null, 2))

if (args.writeMediaReport) {
  const mediaReportPath = path.resolve(args.writeMediaReport)
  await mkdir(path.dirname(mediaReportPath), { recursive: true })
  await writeFile(mediaReportPath, `${JSON.stringify(summary, null, 2)}\n`)
}

if (failures.length > 0) {
  console.error("\n录屏质量门禁失败：")
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log("\n录屏质量门禁通过。")
