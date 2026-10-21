#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const PRESETS = {
  "customer-desktop": {
    format: "mp4",
    canvasWidth: 1920,
    canvasHeight: 1080,
    padding: 96,
    background: "#101612",
    crf: 20,
    fps: null
  },
  "customer-mobile": {
    format: "mp4",
    canvasWidth: 1080,
    canvasHeight: 1920,
    padding: 0,
    background: "#101612",
    crf: 20,
    fps: null
  },
  "social-mobile": {
    format: "mp4",
    canvasWidth: 1080,
    canvasHeight: 1920,
    padding: 72,
    background: "#101612",
    crf: 21,
    fps: 30
  },
  "qa-proof": {
    format: "mp4",
    canvasWidth: null,
    canvasHeight: null,
    padding: 0,
    background: "#000000",
    crf: 18,
    fps: null
  },
  "readme-gif": {
    format: "gif",
    width: 960,
    fps: 12
  }
}

const DEFAULTS = {
  video: null,
  out: null,
  preset: "customer-desktop",
  canvasWidth: null,
  canvasHeight: null,
  padding: null,
  background: null,
  crf: null,
  presetName: "veryfast",
  fps: null,
  keepTemp: false
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/polish-video.mjs --video <input.mp4> --out <output.mp4|gif> [options]

Options:
  --preset <name>          customer-desktop | customer-mobile | social-mobile | qa-proof | readme-gif
  --canvas-width <px>      Override output canvas width
  --canvas-height <px>     Override output canvas height
  --padding <px>           Inset around the recording for framed presets
  --background <hex>       Background color, e.g. #101612
  --crf <n>                H.264 CRF (default depends on preset)
  --fps <n>                Optional output FPS
  --width <px>             GIF width for readme-gif preset
  --keep-temp              Keep temporary GIF palette files
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
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`)
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    args[key] = value
    index += 1
  }

  if (!args.video) throw new Error("Missing --video <input>")
  if (!args.out) throw new Error("Missing --out <output>")
  if (!PRESETS[args.preset]) throw new Error(`Unknown --preset: ${args.preset}`)

  const preset = PRESETS[args.preset]
  args.format = preset.format
  args.canvasWidth = numberOr(args.canvasWidth, preset.canvasWidth)
  args.canvasHeight = numberOr(args.canvasHeight, preset.canvasHeight)
  args.padding = numberOr(args.padding, preset.padding)
  args.background = normalizeColor(args.background || preset.background || "#000000")
  args.crf = numberOr(args.crf, preset.crf)
  args.fps = numberOr(args.fps, preset.fps)
  args.gifWidth = numberOr(args.width, preset.width)

  if (args.format === "mp4") {
    if (args.canvasWidth != null && (!Number.isFinite(args.canvasWidth) || args.canvasWidth < 320)) {
      throw new Error("--canvas-width must be >= 320")
    }
    if (args.canvasHeight != null && (!Number.isFinite(args.canvasHeight) || args.canvasHeight < 180)) {
      throw new Error("--canvas-height must be >= 180")
    }
    if (!Number.isFinite(args.padding) || args.padding < 0) throw new Error("--padding must be >= 0")
    if (!Number.isFinite(args.crf) || args.crf < 0 || args.crf > 51) throw new Error("--crf must be 0-51")
  }

  return args
}

function numberOr(value, fallback) {
  if (value == null || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeColor(value) {
  const text = String(value || "").trim()
  const match = text.match(/^#?([0-9a-f]{6})$/i)
  if (!match) throw new Error(`Invalid color: ${value}`)
  return `0x${match[1].toLowerCase()}`
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
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`))
    })
  })
}

function mp4Filter(args) {
  const fpsFilter = args.fps ? `fps=${args.fps},` : ""
  if (!args.canvasWidth || !args.canvasHeight) {
    return `${fpsFilter}format=yuv420p`
  }

  const contentWidth = Math.max(2, Math.floor(args.canvasWidth - args.padding * 2))
  const contentHeight = Math.max(2, Math.floor(args.canvasHeight - args.padding * 2))
  return [
    fpsFilter ? fpsFilter.slice(0, -1) : null,
    `scale=${contentWidth}:${contentHeight}:force_original_aspect_ratio=decrease`,
    "setsar=1",
    `pad=${args.canvasWidth}:${args.canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=${args.background}`,
    "format=yuv420p"
  ]
    .filter(Boolean)
    .join(",")
}

function ffprobeJson(filePath) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath],
    { encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe failed: ${filePath}`)
  }
  return JSON.parse(result.stdout)
}

function isAttachedPic(stream) {
  return Number(stream?.disposition?.attached_pic || 0) === 1
}

async function polishMp4(args) {
  const inputPath = path.resolve(args.video)
  const outputPath = path.resolve(args.out)
  await mkdir(path.dirname(outputPath), { recursive: true })

  // 探测源视频是否有 attached_pic 封面流，polish 时需要原样保留，否则会丢封面
  let probe = null
  try {
    probe = ffprobeJson(inputPath)
  } catch {
    probe = null
  }
  const coverStream = probe?.streams?.find((stream) => stream.codec_type === "video" && isAttachedPic(stream)) || null
  const hasAudio = Boolean(probe?.streams?.some((stream) => stream.codec_type === "audio"))

  const ffmpegArgs = ["-y", "-i", inputPath]
  ffmpegArgs.push(
    "-filter_complex",
    `[0:v:0]${mp4Filter(args)}[outv]`,
    "-map",
    "[outv]"
  )
  if (hasAudio) ffmpegArgs.push("-map", "0:a:0?")
  if (coverStream) {
    ffmpegArgs.push("-map", `0:${coverStream.index}`)
  }
  ffmpegArgs.push(
    "-c:v:0",
    "libx264",
    "-crf",
    String(args.crf),
    "-preset",
    args.presetName,
    "-pix_fmt",
    "yuv420p"
  )
  if (hasAudio) ffmpegArgs.push("-c:a", "aac", "-b:a", "160k")
  if (coverStream) {
    // ffmpeg `-c:v:N` 中 N 指的是输出 video stream 的序号（不算 audio）。
    // 输出顺序：主 video → 可选 audio → cover（attached_pic）。
    // 所以 cover 总是输出中的第 2 个 video stream，索引固定为 1。
    const coverVideoIndex = 1
    ffmpegArgs.push(
      `-c:v:${coverVideoIndex}`,
      "copy",
      `-disposition:v:${coverVideoIndex}`,
      "attached_pic",
      `-metadata:s:v:${coverVideoIndex}`,
      `title=${coverStream.tags?.title || "Cover"}`,
      `-metadata:s:v:${coverVideoIndex}`,
      `comment=${coverStream.tags?.comment || "Cover (front)"}`
    )
  }
  ffmpegArgs.push("-movflags", "+faststart", outputPath)
  await run("ffmpeg", ffmpegArgs)

  // 验证 polish 后封面流是否被正确保留
  if (coverStream) {
    const outputProbe = ffprobeJson(outputPath)
    const outputCover = outputProbe.streams?.find(
      (stream) => stream.codec_type === "video" && isAttachedPic(stream)
    )
    if (!outputCover) {
      throw new Error(
        "polish 后丢失了源视频的 attached_pic 封面流，请检查 ffmpeg 是否支持 png/mjpeg 流复制"
      )
    }
  }
}

async function polishGif(args) {
  if (!Number.isFinite(args.gifWidth) || args.gifWidth < 240) throw new Error("--width must be >= 240")
  const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-gif-"))
  const palette = path.join(tempDir, "palette.png")
  const filters = `fps=${args.fps || 12},scale=${args.gifWidth}:-1:flags=lanczos`
  try {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true })
    await run("ffmpeg", ["-y", "-i", path.resolve(args.video), "-vf", `${filters},palettegen`, palette])
    await run("ffmpeg", [
      "-y",
      "-i",
      path.resolve(args.video),
      "-i",
      palette,
      "-filter_complex",
      `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
      path.resolve(args.out)
    ])
  } finally {
    if (!args.keepTemp) await rm(tempDir, { recursive: true, force: true })
  }
}

const args = parseArgs(process.argv.slice(2))
const startedAt = new Date().toISOString()

for (const tool of ["ffmpeg", "ffprobe"]) {
  if (spawnSync(tool, ["-version"], { stdio: "ignore" }).error) {
    console.error(`需要 ${tool} 才能做后期导出：请先安装（macOS: brew install ffmpeg），再重跑本命令`)
    process.exit(1)
  }
}

if (args.format === "gif") {
  await polishGif(args)
} else {
  await polishMp4(args)
}

const reportPath = path.resolve(args.out).replace(/\.[^.]+$/, "-polish-report.json")
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      createdAt: startedAt,
      input: path.resolve(args.video),
      output: path.resolve(args.out),
      preset: args.preset,
      format: args.format,
      canvasWidth: args.canvasWidth,
      canvasHeight: args.canvasHeight,
      padding: args.padding,
      background: args.background,
      crf: args.crf,
      fps: args.fps
    },
    null,
    2
  )}\n`
)

console.log(`Generated polished ${args.format.toUpperCase()}: ${path.resolve(args.out)}`)
console.log(`Generated polish report: ${reportPath}`)
