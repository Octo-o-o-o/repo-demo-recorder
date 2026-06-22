#!/usr/bin/env node

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const DEFAULTS = {
  out: null,
  report: null,
  combinedReport: null,
  manifest: null,
  segmentsDir: null,
  segment: [],
  segmentTitle: [],
  segmentSubtitle: [],
  segmentLine: [],
  segmentReport: [],
  transitionDurationMs: 1100,
  transitionLabel: null,
  width: null,
  height: null,
  fps: null,
  theme: "customer",
  videoCodec: "libx264",
  videoCrf: 20,
  videoPreset: "veryfast",
  audioBitrate: "160k",
  keepTemp: false
}

const ALLOWED_THEMES = new Set(["customer", "proof", "training", "mobile"])

function printHelpAndExit() {
  console.log(`Usage: node scripts/assemble-segmented-video.mjs --out <mp4> --segment <mp4> [--segment <mp4> ...] [options]

Assemble one or more segment videos. When there is only one segment the script copies it without
adding an intermediate slate. When there are multiple segments it inserts a short, low-intensity
"next segment" transition cover before each segment after the first.

Options:
  --manifest <json>              JSON manifest with { segments: [{ video, title, subtitle, line, report }] }
  --segment <mp4>                Segment video; repeat in playback order
  --segment-title <text>         Title for the segment; repeat in segment order
  --segment-subtitle <text>      Optional subtitle for the segment transition; repeat in segment order
  --segment-line <text>          Optional low-emphasis line for the segment transition; repeat in segment order
  --segment-report <json>        Segment report to merge into --combined-report; repeat in segment order
  --segments-dir <dir>           Directory for generated normalized segments and transition cover assets
  --transition-duration-ms <n>   Transition duration between segments (default: 1100)
  --transition-label <text>      Small label above the next segment title (default: 接下来 / Next)
  --width <px>                   Output width (default: first segment width)
  --height <px>                  Output height (default: first segment height)
  --fps <n>                      Output FPS (default: first segment FPS, clamped to 1-60)
  --theme <name>                 customer | proof | training | mobile
  --video-crf <n>                x264 CRF for normalized clips (default: 20)
  --video-preset <name>          x264 preset (default: veryfast)
  --audio-bitrate <rate>         AAC audio bitrate (default: 160k)
  --report <json>                Assembly report path (default: <out>-assemble-report.json)
  --combined-report <json>       Write a merged recording report with shifted timestamps
  --keep-temp                    Keep temp files
`)
  process.exit(0)
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) printHelpAndExit()

  const args = { ...DEFAULTS, segment: [], segmentTitle: [], segmentSubtitle: [], segmentLine: [], segmentReport: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--keep-temp") {
      args.keepTemp = true
      continue
    }
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }
    const key = toCamelCase(token.slice(2))
    if (!(key in args)) {
      throw new Error(
        `无法识别参数：${token}。详见 --help。支持 --segment / --segment-title / --segment-report / --manifest / --out 等参数。`
      )
    }
    if (Array.isArray(args[key])) {
      args[key].push(value)
    } else {
      args[key] = value
    }
    index += 1
  }

  if (!args.out) throw new Error("缺少 --out <mp4>")
  args.transitionDurationMs = Number(args.transitionDurationMs)
  args.width = args.width == null ? null : Number(args.width)
  args.height = args.height == null ? null : Number(args.height)
  args.fps = args.fps == null ? null : Number(args.fps)
  args.videoCrf = Number(args.videoCrf)

  if (!Number.isFinite(args.transitionDurationMs) || args.transitionDurationMs < 300) {
    throw new Error("--transition-duration-ms 必须是 >= 300 的数字")
  }
  if (args.width != null && (!Number.isFinite(args.width) || args.width < 320)) {
    throw new Error("--width 必须是 >= 320 的数字")
  }
  if (args.height != null && (!Number.isFinite(args.height) || args.height < 180)) {
    throw new Error("--height 必须是 >= 180 的数字")
  }
  if (args.fps != null && (!Number.isFinite(args.fps) || args.fps < 1 || args.fps > 60)) {
    throw new Error("--fps 必须在 1-60 之间")
  }
  if (!Number.isFinite(args.videoCrf) || args.videoCrf < 0 || args.videoCrf > 51) {
    throw new Error("--video-crf 必须在 0-51 之间")
  }
  if (!ALLOWED_THEMES.has(args.theme)) {
    throw new Error(`--theme must be one of: ${Array.from(ALLOWED_THEMES).join(", ")}`)
  }
  return args
}

function toCamelCase(value) {
  return value.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  return result.status === 0
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
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`))
    })
  })
}

async function ffprobeJson(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ])
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

function parseFrameRate(raw) {
  if (!raw || raw === "0/0") return null
  const [numerator, denominator] = String(raw).split("/").map(Number)
  if (!Number.isFinite(numerator) || numerator <= 0) return null
  if (!Number.isFinite(denominator) || denominator <= 0) return numerator
  return numerator / denominator
}

function clampFps(value) {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return 25
  return Math.min(60, Math.max(1, fps))
}

function ffmpegTime(seconds) {
  return Math.max(0, Number(seconds || 0)).toFixed(3)
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function isChineseText(...values) {
  return /[一-龥]/.test(values.filter(Boolean).join(""))
}

function fileTitle(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim()
}

function reportTitle(report) {
  const captions = Array.isArray(report?.captions) ? report.captions : []
  return captions.find((cue) => cue?.title)?.title || report?.title || report?.scenario || null
}

function reportLine(report) {
  const captions = Array.isArray(report?.captions) ? report.captions : []
  const text = captions.find((cue) => cue?.body)?.body || captions.find((cue) => cue?.title)?.title || ""
  return String(text || "").slice(0, 48)
}

async function loadJsonMaybe(filePath) {
  if (!filePath) return null
  return JSON.parse(await readFile(filePath, "utf8"))
}

function resolveMaybe(baseDir, value) {
  if (!value) return null
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value)
}

async function loadSegments(args) {
  const cliHasSegments = args.segment.length > 0
  let manifestSegments = []
  let manifestDir = process.cwd()

  if (args.manifest) {
    const manifestPath = path.resolve(args.manifest)
    manifestDir = path.dirname(manifestPath)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (!Array.isArray(manifest.segments)) {
      throw new Error("--manifest JSON 必须包含 segments 数组")
    }
    manifestSegments = manifest.segments
  }
  if (args.manifest && cliHasSegments) {
    throw new Error("--manifest 和 --segment 不要混用；请选择一种输入方式")
  }

  const rawSegments = args.manifest
    ? manifestSegments
    : args.segment.map((video, index) => ({
        video,
        title: args.segmentTitle[index] || null,
        subtitle: args.segmentSubtitle[index] || null,
        line: args.segmentLine[index] || null,
        report: args.segmentReport[index] || null
      }))

  if (rawSegments.length === 0) {
    throw new Error("至少需要一个 --segment <mp4>，或提供包含 segments[] 的 --manifest")
  }

  return Promise.all(
    rawSegments.map(async (segment, index) => {
      const segmentObj = typeof segment === "string" ? { video: segment } : segment
      const baseDir = args.manifest ? manifestDir : process.cwd()
      const video = resolveMaybe(baseDir, segmentObj.video)
      const reportPath = resolveMaybe(baseDir, segmentObj.report)
      if (!video) throw new Error(`segments[${index}] 缺少 video`)
      if (!existsSync(video)) throw new Error(`segment video 不存在：${video}`)
      const report = await loadJsonMaybe(reportPath)
      return {
        index,
        video,
        reportPath,
        report,
        title: segmentObj.title || reportTitle(report) || fileTitle(video),
        subtitle: segmentObj.subtitle || null,
        line: segmentObj.line || reportLine(report) || null
      }
    })
  )
}

async function loadChromium() {
  try {
    const mod = await import("playwright")
    return mod.chromium
  } catch {
    try {
      const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"))
      return requireFromCwd("playwright").chromium
    } catch {
      return null
    }
  }
}

function ffmpegHasDrawtext() {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" })
  if (result.status !== 0) return false
  return /(^|\s)drawtext\s/m.test(result.stdout || "")
}

async function dataUrl(filePath) {
  const bytes = await readFile(filePath)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

function transitionHtml({ src, text, width, height }) {
  const portrait = height > width
  const title = escapeHtml(text.title)
  const subtitle = escapeHtml(text.subtitle)
  const line = escapeHtml(text.line)
  const label = escapeHtml(text.label)
  const progress = escapeHtml(text.progress)
  const titleSize = portrait ? Math.round(height * 0.044) : Math.round(width * 0.043)
  const subtitleSize = portrait ? Math.round(height * 0.021) : Math.round(width * 0.021)
  const lineSize = portrait ? Math.round(height * 0.016) : Math.round(width * 0.015)
  const labelSize = portrait ? Math.round(height * 0.015) : Math.round(width * 0.014)
  const copyWidth = portrait ? "calc(100% - 120px)" : "min(760px, 58%)"
  const copyLeft = portrait ? "60px" : "6.2%"
  const copyTop = portrait ? "18%" : "50%"
  const copyTransform = portrait ? "none" : "translateY(-50%)"
  const accentWidth = portrait ? "240px" : "320px"

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","STHeiti","Segoe UI",sans-serif;background:#101612}
.stage{position:relative;width:${width}px;height:${height}px;color:#fff}
.bg{position:absolute;inset:-24px;background-image:url('${src}');background-size:cover;background-position:center;filter:blur(12px) saturate(.84);transform:scale(1.04);opacity:.66}
.shade{position:absolute;inset:0;background:${portrait ? "linear-gradient(180deg,rgba(8,18,13,.92) 0%,rgba(8,18,13,.72) 39%,rgba(8,18,13,.50) 100%)" : "linear-gradient(90deg,rgba(8,18,13,.92) 0%,rgba(8,18,13,.78) 42%,rgba(8,18,13,.45) 100%)"}}
.grain{position:absolute;inset:0;background:rgba(255,255,255,.018)}
.rule{position:absolute;left:${copyLeft};top:${portrait ? "14%" : "17%"};width:${accentWidth};height:${portrait ? "5px" : "4px"};border-radius:999px;background:linear-gradient(90deg,#60b57a,#c4d9bf);opacity:.82}
.copy{position:absolute;left:${copyLeft};top:${copyTop};transform:${copyTransform};width:${copyWidth}}
.label{display:inline-flex;align-items:center;gap:10px;color:#e8fff0;background:rgba(62,126,86,.54);border:1px solid rgba(232,255,240,.18);border-radius:999px;padding:${portrait ? "10px 15px" : "8px 13px"};font-size:${labelSize}px;font-weight:750;letter-spacing:.035em}
h1{margin:${portrait ? "54px" : "34px"} 0 0;font-size:${titleSize}px;line-height:1.07;letter-spacing:0;font-weight:820;max-width:100%;overflow-wrap:break-word}
h2{margin:${portrait ? "24px" : "20px"} 0 0;font-size:${subtitleSize}px;line-height:1.28;letter-spacing:0;font-weight:700;color:rgba(247,250,246,.93);max-width:${portrait ? "100%" : "82%"}}
.line{margin-top:${portrait ? "28px" : "22px"};font-size:${lineSize}px;line-height:1.45;color:rgba(230,239,232,.72);max-width:${portrait ? "100%" : "76%"}}
.progress{position:absolute;right:${portrait ? "60px" : "6.2%"};bottom:${portrait ? "60px" : "8.5%"};font-size:${lineSize}px;color:rgba(236,245,238,.58);font-weight:650}
</style></head><body><div class="stage">
<div class="bg"></div><div class="shade"></div><div class="grain"></div><div class="rule"></div>
<section class="copy"><div class="label">${label}</div><h1>${title}</h1><h2>${subtitle}</h2><div class="line">${line}</div></section>
<div class="progress">${progress}</div>
</div></body></html>`
}

async function renderTransitionWithChromium(page, framePath, outPath, text, target) {
  const src = await dataUrl(framePath)
  await page.setViewportSize({ width: target.width, height: target.height })
  await page.setContent(transitionHtml({ src, text, width: target.width, height: target.height }), {
    waitUntil: "networkidle"
  })
  await page.screenshot({ path: outPath })
}

async function renderTransitionWithFfmpeg(framePath, outPath, text, target, drawtextAvailable) {
  const { width, height } = target
  const portrait = height > width
  const titleFontSize = portrait ? Math.round(height * 0.044) : Math.round(width * 0.043)
  const subtitleFontSize = portrait ? Math.round(height * 0.021) : Math.round(width * 0.021)
  const lineFontSize = portrait ? Math.round(height * 0.016) : Math.round(width * 0.015)
  const labelFontSize = portrait ? Math.round(height * 0.015) : Math.round(width * 0.014)
  const x = portrait ? Math.round(width * 0.065) : Math.round(width * 0.062)
  const titleY = portrait ? Math.round(height * 0.25) : Math.round(height * 0.38)
  const subtitleY = portrait ? Math.round(height * 0.34) : Math.round(height * 0.51)
  const lineY = portrait ? Math.round(height * 0.41) : Math.round(height * 0.61)
  const labelY = portrait ? Math.round(height * 0.19) : Math.round(height * 0.31)
  const fontFile = process.env.REPO_DEMO_RECORDER_FONT_FILE || ""
  const fontArg = fontFile ? `fontfile='${fontFile.replace(/'/g, "\\'")}':` : ""
  const escapeForDrawtext = (value) =>
    String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/:/g, "\\:")
      .replace(/%/g, "\\%")

  if (!drawtextAvailable) {
    await run("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      framePath,
      "-filter_complex",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=12,eq=brightness=-0.24:saturation=0.84,format=rgba,colorchannelmixer=aa=0.82[out]`,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      outPath
    ])
    return
  }

  const drawTexts = [
    `${fontArg}drawtext=text='${escapeForDrawtext(text.label)}':fontcolor=white@0.90:fontsize=${labelFontSize}:x=${x}:y=${labelY}:box=1:boxcolor=0x3e7e56@0.52:boxborderw=10`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.title)}':fontcolor=white:fontsize=${titleFontSize}:x=${x}:y=${titleY}`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.subtitle)}':fontcolor=white@0.88:fontsize=${subtitleFontSize}:x=${x}:y=${subtitleY}`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.line)}':fontcolor=white@0.72:fontsize=${lineFontSize}:x=${x}:y=${lineY}`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.progress)}':fontcolor=white@0.58:fontsize=${lineFontSize}:x=w-tw-${x}:y=h-${Math.round(height * 0.085)}`
  ]
  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    framePath,
    "-filter_complex",
    [
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=12,eq=brightness=-0.24:saturation=0.84[bg]`,
      `[bg]drawbox=x=${x}:y=${portrait ? Math.round(height * 0.15) : Math.round(height * 0.18)}:w=${portrait ? Math.round(width * 0.24) : Math.round(width * 0.24)}:h=4:color=0x60b57a@0.82:t=fill,${drawTexts.join(",")}[out]`
    ].join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    outPath
  ])
}

async function extractFrame(videoPath, seconds, framePath) {
  await run("ffmpeg", [
    "-y",
    "-ss",
    ffmpegTime(seconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    framePath
  ])
}

function transitionText(segment, index, total, args) {
  const isZh = isChineseText(segment.title, segment.subtitle, segment.line, segment.report?.language)
  const label = args.transitionLabel || (isZh ? "接下来" : "Next")
  const fallbackSubtitle = isZh ? "继续同一条演示流程" : "Continuing the same walkthrough"
  const fallbackLine = isZh ? "短暂停顿，进入下一段关键能力。" : "A brief handoff into the next capability."
  return {
    label,
    title: segment.title || (isZh ? `第 ${index + 1} 段` : `Segment ${index + 1}`),
    subtitle: segment.subtitle || fallbackSubtitle,
    line: segment.line || fallbackLine,
    progress: `${index + 1}/${total}`
  }
}

async function normalizeSegment(segment, outputPath, target, args) {
  const main = mainVideoStream(segment.probe)
  if (!main) throw new Error(`segment 没有主 video stream：${segment.video}`)
  const audio = firstAudioStream(segment.probe)
  const durationSeconds = Number(segment.probe.format?.duration || 0)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`无法读取 segment 时长：${segment.video}`)
  }

  const ffmpegArgs = ["-y", "-i", segment.video]
  const audioInputIndex = audio ? 0 : 1
  if (!audio) {
    ffmpegArgs.push("-f", "lavfi", "-t", ffmpegTime(durationSeconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100")
  }

  const videoLabel = `[0:${main.index}]`
  const audioLabel = `[${audioInputIndex}:${audio ? audio.index : "a"}]`
  const filter = [
    `${videoLabel}scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=0x101612,setsar=1,fps=${target.fps},format=yuv420p[v]`,
    `${audioLabel}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad=whole_dur=${ffmpegTime(durationSeconds)}[a]`
  ].join(";")

  await run("ffmpeg", [
    ...ffmpegArgs,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    ffmpegTime(durationSeconds),
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
    "-movflags",
    "+faststart",
    outputPath
  ])
}

async function makeTransitionClip(imagePath, outputPath, target, args) {
  const durationSeconds = args.transitionDurationMs / 1000
  const fadeOutStart = Math.max(0, durationSeconds - 0.16)
  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-t",
    ffmpegTime(durationSeconds),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-t",
    ffmpegTime(durationSeconds),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex",
    `[0:v]scale=${target.width}:${target.height},setsar=1,fps=${target.fps},format=yuv420p,fade=t=in:st=0:d=0.10,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.16[v];[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
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
    "-movflags",
    "+faststart",
    outputPath
  ])
}

function concatFilePath(filePath) {
  return filePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function concatClips(clips, outputPath, tempDir) {
  const listPath = path.join(tempDir, "concat.txt")
  await writeFile(listPath, clips.map((clip) => `file '${concatFilePath(clip)}'`).join("\n") + "\n")
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ])
}

function shiftNumber(value, offsetMs) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.round(number + offsetMs)) : value
}

function shiftTimingFields(item, offsetMs) {
  const next = { ...item }
  for (const key of ["startMs", "endMs", "atMs", "windowEndMs"]) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = shiftNumber(next[key], offsetMs)
    }
  }
  return next
}

function mergeReports(segments, assembly, args) {
  const firstReport = segments.find((segment) => segment.report)?.report || {}
  const merged = {
    ...firstReport,
    createdAt: new Date().toISOString(),
    scenario: firstReport.scenario ? `${firstReport.scenario}-assembled` : "assembled-demo",
    video: assembly.outputVideo,
    mp4: assembly.outputVideo,
    assembly: {
      schema: assembly.schema,
      sourceReports: segments.map((segment) => segment.reportPath).filter(Boolean),
      transitionCount: assembly.transitionCount,
      transitionDurationMs: args.transitionDurationMs
    },
    captions: [],
    steps: [],
    apiAssertions: [],
    dbAssertions: [],
    consoleMessages: [],
    pageErrors: [],
    responseErrors: []
  }

  for (const segment of assembly.segments) {
    const source = segments[segment.index].report || {}
    for (const cue of Array.isArray(source.captions) ? source.captions : []) {
      merged.captions.push({ ...shiftTimingFields(cue, segment.startMs), segment: segment.id })
    }
    for (const step of Array.isArray(source.steps) ? source.steps : []) {
      merged.steps.push({ ...shiftTimingFields(step, segment.startMs), segment: segment.id })
    }
    for (const item of Array.isArray(source.apiAssertions) ? source.apiAssertions : []) {
      merged.apiAssertions.push({ ...shiftTimingFields(item, segment.startMs), segment: segment.id })
    }
    for (const item of Array.isArray(source.dbAssertions) ? source.dbAssertions : []) {
      merged.dbAssertions.push({ ...item, segment: segment.id })
    }
    for (const item of Array.isArray(source.consoleMessages) ? source.consoleMessages : []) {
      merged.consoleMessages.push({ ...item, segment: segment.id })
    }
    for (const item of Array.isArray(source.pageErrors) ? source.pageErrors : []) {
      merged.pageErrors.push({ segment: segment.id, error: item })
    }
    for (const item of Array.isArray(source.responseErrors) ? source.responseErrors : []) {
      merged.responseErrors.push({ ...item, segment: segment.id })
    }
  }

  for (const transition of assembly.transitions) {
    merged.captions.push({
      kind: "transition",
      title: transition.label,
      body: transition.title,
      narration: false,
      durationMs: transition.endMs - transition.startMs,
      startMs: transition.startMs,
      endMs: transition.endMs,
      segment: transition.beforeSegment
    })
  }
  merged.captions.sort((a, b) => Number(a.startMs || a.atMs || 0) - Number(b.startMs || b.atMs || 0))
  merged.steps.sort((a, b) => Number(a.atMs || 0) - Number(b.atMs || 0))
  return merged
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    throw new Error("需要 ffmpeg 和 ffprobe")
  }

  const outputPath = path.resolve(args.out)
  const reportPath = args.report ? path.resolve(args.report) : outputPath.replace(/\.[^.]+$/, "-assemble-report.json")
  const combinedReportPath = args.combinedReport ? path.resolve(args.combinedReport) : null
  const segments = await loadSegments(args)
  const outputOverwritesInput = segments.some((segment) => path.resolve(segment.video) === outputPath)
  if (segments.length > 1 && outputOverwritesInput) {
    throw new Error("多段合并时 --out 不能覆盖任何 --segment 输入；请输出到新的 MP4 后再替换原文件")
  }
  const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-assemble-"))
  const assetDir = args.segmentsDir ? path.resolve(args.segmentsDir) : path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-segments`)

  let browser = null
  let page = null
  try {
    await mkdir(path.dirname(outputPath), { recursive: true })
    await mkdir(path.dirname(reportPath), { recursive: true })
    if (combinedReportPath) await mkdir(path.dirname(combinedReportPath), { recursive: true })

    for (const segment of segments) {
      segment.probe = await ffprobeJson(segment.video)
      const main = mainVideoStream(segment.probe)
      if (!main?.width || !main?.height) {
        throw new Error(`无法读取 segment 主视频尺寸：${segment.video}`)
      }
      segment.durationSeconds = Number(segment.probe.format?.duration || 0)
      if (!Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0) {
        throw new Error(`无法读取 segment 时长：${segment.video}`)
      }
    }

    const firstMain = mainVideoStream(segments[0].probe)
    const target = {
      width: args.width || firstMain.width,
      height: args.height || firstMain.height,
      fps: clampFps(args.fps || parseFrameRate(firstMain.avg_frame_rate || firstMain.r_frame_rate))
    }

    const assembly = {
      schema: "repo-demo-recorder/segmented-assembly.v1",
      createdAt: new Date().toISOString(),
      outputVideo: outputPath,
      segmentCount: segments.length,
      transitionCount: Math.max(0, segments.length - 1),
      transitionDurationMs: segments.length > 1 ? args.transitionDurationMs : 0,
      target,
      renderer: null,
      skippedReason: segments.length === 1 ? "single segment: no intermediate transition cover needed" : null,
      segments: [],
      transitions: []
    }

    if (segments.length === 1) {
      if (!outputOverwritesInput) {
        await copyFile(segments[0].video, outputPath)
      }
      const durationMs = Math.round(segments[0].durationSeconds * 1000)
      assembly.segments.push({
        index: 0,
        id: "segment-1",
        video: segments[0].video,
        title: segments[0].title,
        durationMs,
        startMs: 0,
        endMs: durationMs
      })
      await writeFile(reportPath, `${JSON.stringify(assembly, null, 2)}\n`)
      if (combinedReportPath) {
        const merged = mergeReports(segments, assembly, args)
        await writeFile(combinedReportPath, `${JSON.stringify(merged, null, 2)}\n`)
      }
      console.log(`仅检测到 1 段视频，未插入中间转场封面：${outputPath}`)
      console.log(`已生成组装报告：${reportPath}`)
      return
    }

    const chromium = await loadChromium()
    const drawtextAvailable = !chromium && ffmpegHasDrawtext()
    assembly.renderer = chromium ? "chromium" : drawtextAvailable ? "ffmpeg-drawtext" : "ffmpeg-frame-only"
    if (!chromium) {
      console.warn(
        drawtextAvailable
          ? "[assemble] Playwright 不可用，段间子封面退化到 ffmpeg drawtext 渲染。"
          : "[assemble] Playwright 不可用，且 ffmpeg 无 drawtext，段间子封面将退化为弱化抽帧，不含文字层。"
      )
    } else {
      browser = await chromium.launch({ headless: true })
      page = await browser.newPage({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1 })
    }

    await mkdir(assetDir, { recursive: true })
    const clips = []
    let cursorMs = 0
    for (const [index, segment] of segments.entries()) {
      const normalizedPath = path.join(assetDir, `segment-${String(index + 1).padStart(2, "0")}.mp4`)
      await normalizeSegment(segment, normalizedPath, target, args)
      clips.push(normalizedPath)

      const normalizedProbe = await ffprobeJson(normalizedPath)
      const durationMs = Math.round(Number(normalizedProbe.format?.duration || segment.durationSeconds) * 1000)
      assembly.segments.push({
        index,
        id: `segment-${index + 1}`,
        video: segment.video,
        normalizedVideo: normalizedPath,
        report: segment.reportPath,
        title: segment.title,
        durationMs,
        startMs: cursorMs,
        endMs: cursorMs + durationMs
      })
      cursorMs += durationMs

      if (index < segments.length - 1) {
        const nextSegment = segments[index + 1]
        const transitionIndex = index + 1
        const framePath = path.join(assetDir, `transition-${String(transitionIndex).padStart(2, "0")}-frame.png`)
        const coverPath = path.join(assetDir, `transition-${String(transitionIndex).padStart(2, "0")}-cover.png`)
        const clipPath = path.join(assetDir, `transition-${String(transitionIndex).padStart(2, "0")}.mp4`)
        const nextProbeDuration = Number(nextSegment.probe.format?.duration || 0)
        const frameAt = Math.max(0, Math.min(nextProbeDuration - 0.1, Math.max(0.35, nextProbeDuration * 0.12)))
        const text = transitionText(nextSegment, index + 1, segments.length, args)

        await extractFrame(nextSegment.video, frameAt, framePath)
        if (page) {
          await renderTransitionWithChromium(page, framePath, coverPath, text, target)
        } else {
          await renderTransitionWithFfmpeg(framePath, coverPath, text, target, drawtextAvailable)
        }
        await makeTransitionClip(coverPath, clipPath, target, args)
        clips.push(clipPath)

        const transitionProbe = await ffprobeJson(clipPath)
        const transitionDurationMs = Math.round(Number(transitionProbe.format?.duration || args.transitionDurationMs / 1000) * 1000)
        assembly.transitions.push({
          index: transitionIndex,
          afterSegment: `segment-${index + 1}`,
          beforeSegment: `segment-${index + 2}`,
          label: text.label,
          title: text.title,
          subtitle: text.subtitle,
          line: text.line,
          progress: text.progress,
          frame: framePath,
          cover: coverPath,
          video: clipPath,
          startMs: cursorMs,
          endMs: cursorMs + transitionDurationMs
        })
        cursorMs += transitionDurationMs
      }
    }

    await concatClips(clips, outputPath, tempDir)
    const outputProbe = await ffprobeJson(outputPath)
    assembly.output = {
      durationSeconds: Number(outputProbe.format?.duration || 0),
      sizeBytes: Number(outputProbe.format?.size || 0)
    }
    await writeFile(reportPath, `${JSON.stringify(assembly, null, 2)}\n`)

    if (combinedReportPath) {
      const merged = mergeReports(segments, assembly, args)
      await writeFile(combinedReportPath, `${JSON.stringify(merged, null, 2)}\n`)
    }

    console.log(`已组装 ${segments.length} 段视频并插入 ${assembly.transitionCount} 个段间子封面：${outputPath}`)
    console.log(`已生成组装报告：${reportPath}`)
    if (combinedReportPath) console.log(`已生成合并 report：${combinedReportPath}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (!args.keepTemp) {
      await rm(tempDir, { recursive: true, force: true })
    } else {
      console.log(`[assemble] temp files kept at ${tempDir}`)
    }
  }
}

await main()
