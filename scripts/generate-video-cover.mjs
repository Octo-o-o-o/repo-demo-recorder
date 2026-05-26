#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULTS = {
  video: null,
  report: null,
  out: null,
  candidatesDir: null,
  title: null,
  subtitle: null,
  line: null,
  badge: null,
  timestamp: "auto",
  width: 1280,
  height: 720,
  theme: "customer",
  keepTemp: false
}

const CANDIDATE_RATIOS = [0.12, 0.22, 0.36, 0.5, 0.66, 0.82]

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/generate-video-cover.mjs --video <mp4> --out <cover.png> [options]

Options:
  --report <json>             Recording report; used to infer title/line/cue times
  --title <text>              Cover title
  --subtitle <text>           Cover subtitle
  --line <text>               Short value line below subtitle
  --badge <text>              Badge text, e.g. CUSTOMER DEMO
  --timestamp <time|auto>     Frame time: 36, 00:00:36, or auto
  --candidates-dir <dir>      Generate candidate covers and contact-sheet.png
  --width <px>                Output width (default: 1280; mobile theme default: 1080)
  --height <px>               Output height (default: 720; mobile theme default: 1920)
  --theme <name>              customer | proof | training | mobile
  --keep-temp                 Keep extracted frame files
`)
    process.exit(0)
  }

  const args = { ...DEFAULTS }
  const provided = new Set()
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
    provided.add(key)
    index += 1
  }

  if (!args.video) throw new Error("Missing --video <mp4/webm>")
  if (!args.out) throw new Error("Missing --out <cover.png>")
  if (args.theme === "mobile") {
    if (!provided.has("width")) args.width = 1080
    if (!provided.has("height")) args.height = 1920
  }
  args.width = Number(args.width)
  args.height = Number(args.height)
  if (!Number.isFinite(args.width) || args.width < 320) throw new Error("--width must be >= 320")
  if (!Number.isFinite(args.height) || args.height < 180) throw new Error("--height must be >= 180")
  return args
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

function parseTimestamp(value, durationSeconds) {
  if (!value || value === "auto") return null
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)
  const parts = String(value).split(":").map(Number)
  if (parts.some((part) => !Number.isFinite(part))) throw new Error(`Invalid --timestamp: ${value}`)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return Math.max(0, Math.min(seconds, durationSeconds - 0.1))
}

function inferText(report, args) {
  const captions = Array.isArray(report?.captions) ? report.captions : []
  const meaningful = captions
    .filter((cue) => cue?.title && cue.kind !== "chapter")
    .map((cue) => cue.title)
    .slice(0, 3)

  const isPortrait = Number(args.height) > Number(args.width)
  return {
    title: args.title || report?.title || "Product Demo",
    subtitle:
      args.subtitle ||
      (args.theme === "mobile" || isPortrait
        ? "Mobile product walkthrough"
        : args.theme === "customer"
          ? "Customer-ready product walkthrough"
          : "Verified product walkthrough"),
    line: args.line || meaningful.join(" · ") || "Scripted recording · Captions · Quality report",
    badge:
      args.badge ||
      (args.theme === "mobile" || isPortrait
        ? "MOBILE DEMO"
        : args.theme === "customer"
          ? "CUSTOMER DEMO"
          : args.theme === "training"
            ? "TRAINING"
            : "VERIFIED DEMO")
  }
}

function pickAutoTime(report, durationSeconds) {
  const captions = Array.isArray(report?.captions) ? report.captions : []
  const preferred = captions.find(
    (cue) =>
      cue.kind !== "chapter" &&
      Number.isFinite(Number(cue.startMs)) &&
      /home|首页|overview|工作台|dashboard/i.test(`${cue.title || ""} ${cue.body || ""}`)
  )
  if (preferred) return Math.max(0, Number(preferred.startMs) / 1000 + 0.8)
  return Math.max(2, Math.min(durationSeconds * 0.22, durationSeconds - 1))
}

async function extractFrame(videoPath, seconds, framePath) {
  await run("ffmpeg", [
    "-y",
    "-ss",
    seconds.toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    framePath
  ])
}

async function dataUrl(filePath) {
  const bytes = await readFile(filePath)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

function coverHtml({ src, text, width, height }) {
  if (height > width) return portraitCoverHtml({ src, text, width, height })
  const title = escapeHtml(text.title)
  const subtitle = escapeHtml(text.subtitle)
  const line = escapeHtml(text.line)
  const badge = escapeHtml(text.badge)
  const headlineSize = width >= 1600 ? 92 : 72
  const subtitleSize = width >= 1600 ? 44 : 35
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","STHeiti","Segoe UI",sans-serif;background:#101612}
.cover{position:relative;width:${width}px;height:${height}px;color:#fff}
.bg{position:absolute;inset:-28px;background-image:url('${src}');background-size:cover;background-position:center;filter:blur(14px) saturate(.86);transform:scale(1.04);opacity:.74}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,18,13,.93) 0%,rgba(8,18,13,.80) 34%,rgba(8,18,13,.42) 61%,rgba(8,18,13,.70) 100%)}
.border{position:absolute;inset:42px;border:1px solid rgba(255,255,255,.14);border-radius:18px}
.copy{position:absolute;left:6%;top:13%;width:34%}
.badge{display:inline-flex;padding:10px 14px;border-radius:999px;background:rgba(62,126,86,.88);color:#e8fff0;font-size:${Math.round(width * 0.0156)}px;font-weight:700;letter-spacing:.04em}
h1{margin:${Math.round(height * 0.105)}px 0 0;font-size:${headlineSize}px;line-height:1.02;letter-spacing:0;font-weight:800}
h2{margin:${Math.round(height * 0.039)}px 0 0;font-size:${subtitleSize}px;line-height:1.25;letter-spacing:0;font-weight:700;color:rgba(248,250,247,.96)}
.line{margin-top:${Math.round(height * 0.039)}px;font-size:${Math.round(width * 0.018)}px;line-height:1.45;color:rgba(230,239,232,.84)}
.accent{margin-top:${Math.round(height * 0.058)}px;width:72%;height:5px;border-radius:999px;background:linear-gradient(90deg,#60b57a,#c4d9bf)}
.screenWrap{position:absolute;right:4.4%;top:14.4%;width:59.4%;height:71.1%;border-radius:18px;box-shadow:0 36px 96px rgba(0,0,0,.42);background:rgba(255,255,255,.08);padding:10px}
.screenBar{height:22px;border-radius:12px 12px 0 0;background:rgba(242,245,239,.88);display:flex;align-items:center;gap:7px;padding-left:13px}
.dot{width:8px;height:8px;border-radius:50%;background:#315f44;opacity:.55}
.screen{width:100%;height:calc(100% - 22px);object-fit:cover;object-position:center;display:block;border-radius:0 0 12px 12px;border:1px solid rgba(255,255,255,.68);border-top:0}
.footer{position:absolute;left:6%;bottom:8.8%;color:rgba(236,245,238,.64);font-size:${Math.round(width * 0.014)}px}
</style></head><body><div class="cover">
<div class="bg"></div><div class="shade"></div><div class="border"></div>
<section class="copy"><div class="badge">${badge}</div><h1>${title}</h1><h2>${subtitle}</h2><div class="line">${line}</div><div class="accent"></div></section>
<div class="screenWrap"><div class="screenBar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><img class="screen" src="${src}" /></div>
<div class="footer">Customer-ready product walkthrough</div>
</div></body></html>`
}

function portraitCoverHtml({ src, text, width, height }) {
  const title = escapeHtml(text.title)
  const subtitle = escapeHtml(text.subtitle)
  const line = escapeHtml(text.line)
  const badge = escapeHtml(text.badge)
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","STHeiti","Segoe UI",sans-serif;background:#101612}
.cover{position:relative;width:${width}px;height:${height}px;color:#fff}
.bg{position:absolute;inset:-42px;background-image:url('${src}');background-size:cover;background-position:center;filter:blur(18px) saturate(.86);transform:scale(1.06);opacity:.78}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,18,13,.96) 0%,rgba(8,18,13,.78) 28%,rgba(8,18,13,.38) 58%,rgba(8,18,13,.90) 100%)}
.border{position:absolute;inset:42px;border:1px solid rgba(255,255,255,.14);border-radius:34px}
.copy{position:absolute;left:70px;right:70px;top:92px;text-align:left}
.badge{display:inline-flex;padding:14px 19px;border-radius:999px;background:rgba(62,126,86,.9);color:#e8fff0;font-size:28px;font-weight:750;letter-spacing:.035em}
h1{margin:70px 0 0;font-size:92px;line-height:1.02;letter-spacing:0;font-weight:850}
h2{margin:34px 0 0;font-size:42px;line-height:1.24;letter-spacing:0;font-weight:760;color:rgba(248,250,247,.96)}
.line{margin-top:24px;font-size:28px;line-height:1.45;color:rgba(230,239,232,.84)}
.accent{margin-top:36px;width:360px;height:6px;border-radius:999px;background:linear-gradient(90deg,#60b57a,#c4d9bf)}
.phoneWrap{position:absolute;left:230px;right:230px;top:690px;height:1040px;border-radius:54px;box-shadow:0 44px 118px rgba(0,0,0,.46);background:rgba(255,255,255,.10);padding:18px}
.phoneTop{height:38px;border-radius:34px 34px 0 0;background:rgba(242,245,239,.90);display:flex;align-items:center;justify-content:center}
.speaker{width:118px;height:9px;border-radius:999px;background:rgba(49,95,68,.35)}
.screen{width:100%;height:calc(100% - 38px);object-fit:cover;object-position:center top;display:block;border-radius:0 0 34px 34px;border:1px solid rgba(255,255,255,.70);border-top:0;background:#f8f8f3}
.footer{position:absolute;left:72px;right:72px;bottom:86px;color:rgba(236,245,238,.72);font-size:25px;line-height:1.4}
</style></head><body><div class="cover">
<div class="bg"></div><div class="shade"></div><div class="border"></div>
<section class="copy"><div class="badge">${badge}</div><h1>${title}</h1><h2>${subtitle}</h2><div class="line">${line}</div><div class="accent"></div></section>
<div class="phoneWrap"><div class="phoneTop"><span class="speaker"></span></div><img class="screen" src="${src}" /></div>
<div class="footer">Portrait-ready product walkthrough</div>
</div></body></html>`
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

async function renderCover(page, framePath, outPath, text, args) {
  const src = await dataUrl(framePath)
  await page.setContent(coverHtml({ src, text, width: args.width, height: args.height }), { waitUntil: "networkidle" })
  await page.screenshot({ path: outPath })
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
      throw new Error(
        "Cannot load Playwright. Install it in the target repository (for example: npm i -D playwright) or run this script from a repo that already has Playwright."
      )
    }
  }
}

async function makeContactSheet(page, images, outPath, args) {
  if (images.length === 0) return
  const columns = Math.min(3, images.length)
  const rows = Math.ceil(images.length / columns)
  const portrait = Number(args.height) > Number(args.width)
  const tileWidth = portrait ? 240 : 426
  const tileHeight = portrait ? 426 : 240
  const tiles = []
  for (const [index, image] of images.entries()) {
    tiles.push(`<figure><img src="${await dataUrl(image)}"><figcaption>Candidate ${index + 1}</figcaption></figure>`)
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#f6f7f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .sheet{display:grid;grid-template-columns:repeat(${columns},${tileWidth}px);gap:12px;padding:12px;width:${columns * tileWidth + (columns - 1) * 12 + 24}px}
    figure{margin:0;background:white;border:1px solid rgba(30,40,34,.18);border-radius:8px;overflow:hidden;box-shadow:0 10px 28px rgba(30,40,34,.10)}
    img{display:block;width:${tileWidth}px;height:${tileHeight}px;object-fit:cover}
    figcaption{padding:7px 10px 9px;font-size:13px;color:#33423a}
  </style></head><body><div class="sheet">${tiles.join("")}</div></body></html>`
  await page.setViewportSize({
    width: columns * tileWidth + (columns - 1) * 12 + 24,
    height: rows * (tileHeight + 38) + (rows - 1) * 12 + 24
  })
  await page.setContent(html, { waitUntil: "networkidle" })
  await page.screenshot({ path: outPath })
}

const args = parseArgs(process.argv.slice(2))
const videoPath = path.resolve(args.video)
const outputPath = path.resolve(args.out)
const report = args.report ? JSON.parse(await readFile(path.resolve(args.report), "utf8")) : null
const probe = await ffprobeJson(videoPath)
const durationSeconds = Number(probe.format?.duration || 0)
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Cannot read video duration")

const text = inferText(report, args)
const selectedTime = parseTimestamp(args.timestamp, durationSeconds) ?? pickAutoTime(report, durationSeconds)
const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-cover-"))
const chromium = await loadChromium()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: args.width, height: args.height }, deviceScaleFactor: 1 })

try {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const selectedFrame = path.join(tempDir, "selected-frame.png")
  await extractFrame(videoPath, selectedTime, selectedFrame)
  await renderCover(page, selectedFrame, outputPath, text, args)

  let candidates = null
  if (args.candidatesDir) {
    const candidatesDir = path.resolve(args.candidatesDir)
    await rm(candidatesDir, { recursive: true, force: true })
    await mkdir(candidatesDir, { recursive: true })
    const candidateImages = []
    const candidateMeta = []
    for (const [index, ratio] of CANDIDATE_RATIOS.entries()) {
      const seconds = Math.max(0, Math.min(durationSeconds - 0.1, durationSeconds * ratio))
      const frame = path.join(candidatesDir, `candidate-${String(index + 1).padStart(2, "0")}-frame.png`)
      const cover = path.join(candidatesDir, `candidate-${String(index + 1).padStart(2, "0")}-cover.png`)
      await extractFrame(videoPath, seconds, frame)
      await renderCover(page, frame, cover, text, args)
      candidateImages.push(cover)
      candidateMeta.push({ index: index + 1, ratio, seconds, frame, cover })
    }
    const contactSheet = path.join(candidatesDir, "contact-sheet.png")
    await makeContactSheet(page, candidateImages, contactSheet, args)
    candidates = { dir: candidatesDir, contactSheet, items: candidateMeta }
    await writeFile(path.join(candidatesDir, "cover-candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`)
  }

  await writeFile(
    outputPath.replace(/\.[^.]+$/, "-cover-report.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceVideo: videoPath,
        sourceReport: args.report ? path.resolve(args.report) : null,
        output: outputPath,
        width: args.width,
        height: args.height,
        orientation: args.height > args.width ? "portrait" : "landscape",
        theme: args.theme,
        timestampSeconds: selectedTime,
        text,
        candidates
      },
      null,
      2
    )}\n`
  )
  console.log(`Generated cover: ${outputPath}`)
  if (candidates?.contactSheet) console.log(`Generated cover candidates: ${candidates.contactSheet}`)
} finally {
  await browser.close()
  if (!args.keepTemp) await rm(tempDir, { recursive: true, force: true })
}
