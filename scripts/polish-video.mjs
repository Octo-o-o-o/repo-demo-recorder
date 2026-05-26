#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

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

async function polishMp4(args) {
  await mkdir(path.dirname(path.resolve(args.out)), { recursive: true })
  const ffmpegArgs = [
    "-y",
    "-i",
    path.resolve(args.video),
    "-vf",
    mp4Filter(args),
    "-c:v",
    "libx264",
    "-crf",
    String(args.crf),
    "-preset",
    args.presetName,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    path.resolve(args.out)
  ]
  await run("ffmpeg", ffmpegArgs)
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
