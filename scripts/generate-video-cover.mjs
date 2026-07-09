#!/usr/bin/env node

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
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
    // fail-fast on typos：之前没校验，--titel "..." 会被静默接受。
    if (!(key in args)) {
      throw new Error(
        `Unknown argument: ${token}. See --help (--video/--report/--out/--title/--subtitle/--line/--badge/--timestamp/--width/--height/--theme/--candidates-dir/--keep-temp).`
      )
    }
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

  // 如果 report 自带 language=zh-* 或 captions 是中文，封面所有 fallback 文案也走中文，
  // 避免英文 fallback 出现在中文项目封面里。
  const reportLanguage = String(report?.language || "").toLowerCase()
  const captionLooksChinese = meaningful.some((title) => /[一-龥]/.test(title || ""))
  const isZh = reportLanguage.startsWith("zh") || captionLooksChinese

  const isPortrait = Number(args.height) > Number(args.width)
  return {
    title: args.title || report?.title || (isZh ? "产品演示" : "Product Demo"),
    subtitle:
      args.subtitle ||
      (isZh
        ? args.theme === "mobile" || isPortrait
          ? "移动端产品走查"
          : args.theme === "customer"
            ? "面向客户的可发版走查"
            : "可验证的产品走查"
        : args.theme === "mobile" || isPortrait
          ? "Mobile product walkthrough"
          : args.theme === "customer"
            ? "Customer-ready product walkthrough"
            : "Verified product walkthrough"),
    line:
      args.line ||
      meaningful.join(" · ") ||
      (isZh ? "脚本录制 · 字幕 · 质量报告" : "Scripted recording · Captions · Quality report"),
    badge:
      args.badge ||
      (isZh
        ? args.theme === "mobile" || isPortrait
          ? "移动端演示"
          : args.theme === "customer"
            ? "客户演示"
            : args.theme === "training"
              ? "培训 SOP"
              : "已验证演示"
        : args.theme === "mobile" || isPortrait
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
  // 这套关键词覆盖工作台 / 数据展示 / 聊天对话 / 报表分析 等大类应用的首屏。
  // 过去只覆盖 dashboard/home 会让聊天类应用永远 fallback 到 22% 时间点。
  const hotspotPattern = /home|首页|overview|工作台|dashboard|chat|对话|聊天|conversation|inbox|消息|主屏|主页|workspace|library|资料库|workspaces?|hub|console|主界面/i
  const preferred = captions.find(
    (cue) =>
      cue.kind !== "chapter" &&
      Number.isFinite(Number(cue.startMs)) &&
      hotspotPattern.test(`${cue.title || ""} ${cue.body || ""}`)
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

// 探测一下 text 主题是否是中文，用来决定模板里的 hardcode 行（footer/水印）是否走中文版本。
// 之前模板里写死了英文 "Customer-ready product walkthrough"，让中文项目的封面右下角永远是英文水印。
function isChineseText(text) {
  const sample = [text?.title, text?.subtitle, text?.line, text?.badge].filter(Boolean).join("")
  return /[一-龥]/.test(sample)
}

function coverHtml({ src, text, width, height }) {
  if (height > width) return portraitCoverHtml({ src, text, width, height })
  const title = escapeHtml(text.title)
  const subtitle = escapeHtml(text.subtitle)
  const line = escapeHtml(text.line)
  const badge = escapeHtml(text.badge)
  const headlineSize = width >= 1600 ? 92 : 72
  const subtitleSize = width >= 1600 ? 44 : 35
  const footer = escapeHtml(isChineseText(text) ? "可发版的产品走查" : "Customer-ready product walkthrough")
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","STHeiti","Segoe UI",sans-serif;background:#101612}
.cover{position:relative;width:${width}px;height:${height}px;color:#fff}
.bg{position:absolute;inset:-28px;background-image:url('${src}');background-size:cover;background-position:center;filter:blur(14px) saturate(.86);transform:scale(1.04);opacity:.74}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,18,13,.93) 0%,rgba(8,18,13,.80) 34%,rgba(8,18,13,.42) 61%,rgba(8,18,13,.70) 100%)}
.border{position:absolute;inset:42px;border:1px solid rgba(255,255,255,.14);border-radius:18px}
.copy{position:absolute;left:6%;top:13%;width:31%}
.badge{display:inline-flex;padding:10px 14px;border-radius:999px;background:rgba(62,126,86,.88);color:#e8fff0;font-size:${Math.round(width * 0.0156)}px;font-weight:700;letter-spacing:.04em}
h1{margin:${Math.round(height * 0.105)}px 0 0;font-size:${headlineSize}px;line-height:1.02;letter-spacing:0;font-weight:800;overflow-wrap:break-word}
h2{margin:${Math.round(height * 0.039)}px 0 0;font-size:${subtitleSize}px;line-height:1.25;letter-spacing:0;font-weight:700;color:rgba(248,250,247,.96)}
.line{margin-top:${Math.round(height * 0.039)}px;font-size:${Math.round(width * 0.018)}px;line-height:1.45;color:rgba(230,239,232,.84)}
.accent{margin-top:${Math.round(height * 0.058)}px;width:72%;height:5px;border-radius:999px;background:linear-gradient(90deg,#60b57a,#c4d9bf)}
.screenWrap{position:absolute;right:4.4%;top:14.4%;width:56%;height:71.1%;border-radius:18px;box-shadow:0 36px 96px rgba(0,0,0,.42);background:rgba(255,255,255,.08);padding:0;display:flex;align-items:center;justify-content:center}
.screenBar{display:none}
.dot{width:8px;height:8px;border-radius:50%;background:#315f44;opacity:.55}
.screen{width:100%;height:100%;object-fit:contain;object-position:center;display:block;border-radius:14px;border:1px solid rgba(255,255,255,.68);background:rgba(246,248,244,.72)}
.footer{position:absolute;left:6%;bottom:8.8%;color:rgba(236,245,238,.64);font-size:${Math.round(width * 0.014)}px}
</style></head><body><div class="cover">
<div class="bg"></div><div class="shade"></div><div class="border"></div>
<section class="copy"><div class="badge">${badge}</div><h1>${title}</h1><h2>${subtitle}</h2><div class="line">${line}</div><div class="accent"></div></section>
<div class="screenWrap"><div class="screenBar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><img class="screen" src="${src}" /></div>
<div class="footer">${footer}</div>
</div></body></html>`
}

function portraitCoverHtml({ src, text, width, height }) {
  const title = escapeHtml(text.title)
  const subtitle = escapeHtml(text.subtitle)
  const line = escapeHtml(text.line)
  const badge = escapeHtml(text.badge)
  const footer = escapeHtml(isChineseText(text) ? "竖屏产品走查" : "Portrait-ready product walkthrough")
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
.screen{width:100%;height:calc(100% - 38px);object-fit:contain;object-position:center;display:block;border-radius:0 0 34px 34px;border:1px solid rgba(255,255,255,.70);border-top:0;background:#f8f8f3}
.footer{position:absolute;left:72px;right:72px;bottom:86px;color:rgba(236,245,238,.72);font-size:25px;line-height:1.4}
</style></head><body><div class="cover">
<div class="bg"></div><div class="shade"></div><div class="border"></div>
<section class="copy"><div class="badge">${badge}</div><h1>${title}</h1><h2>${subtitle}</h2><div class="line">${line}</div><div class="accent"></div></section>
<div class="phoneWrap"><div class="phoneTop"><span class="speaker"></span></div><img class="screen" src="${src}" /></div>
<div class="footer">${footer}</div>
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
      return null
    }
  }
}

// 检测系统 ffmpeg 是否真的编译了 drawtext（需要 libfreetype）。
// Homebrew 默认 build 早期不带 freetype；brew tap 的多数 ffmpeg 8.x 也不一定带。
// 我们要在 fallback 之前知道这一点，避免给用户一个"看起来失败"的封面命令。
function ffmpegHasDrawtext() {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" })
  if (result.status !== 0) return false
  return /(^|\s)drawtext\s/m.test(result.stdout || "")
}

// 纯抽帧 fallback：当系统 ffmpeg 不支持 drawtext 时，至少把抽帧导出为封面，
// 让后续 embed-video-cover 仍然有 PNG 可嵌。文字层留给用户在外部工具里加，或安装 playwright 后重跑。
async function renderCoverFrameOnly(framePath, outPath, args) {
  const width = Number(args.width)
  const height = Number(args.height)
  // 保留长宽比，完整居中到目标尺寸；不渲染任何文字层。
  const filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101612[out]`
  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    framePath,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    outPath
  ])
}

// 当 chromium 不可用（典型场景：纯外部录屏工作流，比如 iOS 原生项目根本不装 playwright）时，
// 我们退化到只用 ffmpeg drawtext + overlay 生成一个朴素但可用的封面。
// 不依赖任何 Node 渲染库，只要系统的 ffmpeg 带 drawtext (libfreetype) 即可。
async function renderCoverWithFfmpeg(framePath, outPath, text, args) {
  const portrait = Number(args.height) > Number(args.width)
  const width = Number(args.width)
  const height = Number(args.height)
  // ffmpeg drawtext 在 `text='...'` 内部把 `\` 当转义符；要写一个字面 `\` 必须 `\\`，
  // 字面 `'` 用 `\'`，字面 `:` 用 `\:`、字面 `%` 用 `\%`。
  // 注意 JS 字符串中要写两个反斜杠才是一个真实反斜杠。
  // 之前这里多了几层反斜杠（4个/3个反斜杠），导致 drawtext 把内容解析得乱七八糟。
  const escapeForDrawtext = (value) =>
    String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/:/g, "\\:")
      .replace(/%/g, "\\%")
  const titleFontSize = portrait ? Math.round(height * 0.05) : Math.round(width * 0.046)
  const subtitleFontSize = portrait ? Math.round(height * 0.023) : Math.round(width * 0.022)
  const lineFontSize = portrait ? Math.round(height * 0.018) : Math.round(width * 0.016)
  const badgeFontSize = portrait ? Math.round(height * 0.017) : Math.round(width * 0.015)
  const titleY = portrait ? Math.round(height * 0.12) : Math.round(height * 0.18)
  const subtitleY = portrait ? Math.round(height * 0.22) : Math.round(height * 0.30)
  const lineY = portrait ? Math.round(height * 0.30) : Math.round(height * 0.40)
  const badgeY = portrait ? Math.round(height * 0.07) : Math.round(height * 0.12)
  const fontFile = process.env.REPO_DEMO_RECORDER_FONT_FILE || ""
  const fontArg = fontFile ? `fontfile='${fontFile.replace(/'/g, "\\'")}':` : ""
  const drawTexts = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62:t=fill`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.badge)}':fontcolor=white@0.9:fontsize=${badgeFontSize}:x=(w*0.06):y=${badgeY}:box=1:boxcolor=0x3e7e56@0.85:boxborderw=12`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.title)}':fontcolor=white:fontsize=${titleFontSize}:x=(w*0.06):y=${titleY}`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.subtitle)}':fontcolor=white@0.92:fontsize=${subtitleFontSize}:x=(w*0.06):y=${subtitleY}`,
    `${fontArg}drawtext=text='${escapeForDrawtext(text.line)}':fontcolor=white@0.82:fontsize=${lineFontSize}:x=(w*0.06):y=${lineY}`
  ]
  const filter = [
    `[1:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=22,eq=brightness=-0.18:saturation=0.85[bg]`,
    `[1:v]scale=${portrait ? Math.round(width * 0.72) : Math.round(width * 0.5)}:-1[fg]`,
    `[bg][fg]overlay=${portrait ? "(W-w)/2:(H-h)/2+80" : "W-w-W*0.06:(H-h)/2"}[ovly]`,
    `[ovly]${drawTexts.join(",")}[out]`
  ].join(";")
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x101612:s=${width}x${height}`,
    "-loop",
    "1",
    "-i",
    framePath,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    outPath
  ])
}

// candidates 目录可能被重复写入；只清理本工具自己生成的文件，避免误删用户已有内容
const CANDIDATE_MARKER = "cover-candidates.json"
const CANDIDATE_FILE_PATTERN = /^(candidate-\d+-(?:frame|cover)\.png|contact-sheet\.png|cover-candidates\.json)$/

async function prepareCandidatesDir(candidatesDir) {
  if (!existsSync(candidatesDir)) return
  const entries = await readdir(candidatesDir, { withFileTypes: true })
  if (entries.length === 0) return
  const hasMarker = entries.some((entry) => entry.isFile() && entry.name === CANDIDATE_MARKER)
  const unexpected = entries.filter(
    (entry) => !(entry.isFile() && CANDIDATE_FILE_PATTERN.test(entry.name))
  )
  if (!hasMarker && unexpected.length > 0) {
    throw new Error(
      `候选封面目录已存在且包含非本工具生成的内容，拒绝写入以免覆盖：${candidatesDir}\n` +
        `请改用一个新的 --candidates-dir，或手动清空该目录后再重试。`
    )
  }
  for (const entry of entries) {
    if (entry.isFile() && CANDIDATE_FILE_PATTERN.test(entry.name)) {
      await rm(path.join(candidatesDir, entry.name), { force: true })
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
    img{display:block;width:${tileWidth}px;height:${tileHeight}px;object-fit:contain;background:#f6f7f4}
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
for (const tool of ["ffmpeg", "ffprobe"]) {
  if (spawnSync(tool, ["-version"], { stdio: "ignore" }).error) {
    console.error(`需要 ${tool} 才能生成封面：请先安装（macOS: brew install ffmpeg），再重跑本命令`)
    process.exit(1)
  }
}
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
const drawtextAvailable = !chromium && ffmpegHasDrawtext()
const renderer = chromium
  ? "chromium"
  : drawtextAvailable
    ? "ffmpeg-drawtext"
    : "ffmpeg-frame-only"
const browser = chromium ? await chromium.launch({ headless: true }) : null
const page = browser
  ? await browser.newPage({ viewport: { width: args.width, height: args.height }, deviceScaleFactor: 1 })
  : null
if (!chromium) {
  if (drawtextAvailable) {
    console.warn(
      "[cover] Playwright 不可用，退化到 ffmpeg drawtext 渲染封面。文字层会比 chromium 渲染朴素一些，可设置 REPO_DEMO_RECORDER_FONT_FILE 指定 .ttf/.otf 字体路径获得更好排版。"
    )
  } else {
    console.warn(
      "[cover] Playwright 不可用，且系统 ffmpeg 没有 drawtext (libfreetype) 滤镜，进一步退化到\"只输出抽帧封面\"。\n" +
        "    后续 embed-video-cover.mjs 仍能正常工作，但封面没有标题/副标题/badge 文字层。\n" +
        "    需要文字层时请：1) 在目标项目 `npm i -D playwright`；或 2) 安装带 freetype 的 ffmpeg（macOS: brew install ffmpeg --HEAD 或带 freetype 的 build）。"
    )
  }
}

async function renderCoverDispatch(framePath, outPath) {
  if (page) {
    await renderCover(page, framePath, outPath, text, args)
  } else if (drawtextAvailable) {
    await renderCoverWithFfmpeg(framePath, outPath, text, args)
  } else {
    await renderCoverFrameOnly(framePath, outPath, args)
  }
}

async function makeContactSheetDispatch(images, outPath) {
  if (page) {
    await makeContactSheet(page, images, outPath, args)
    return
  }
  if (images.length === 0) return
  // ffmpeg fallback：用 hstack+vstack 拼成 contact sheet。
  // tile filter 只接受单个 video sequence，无法直接拼多个 input；hstack/vstack 才是多输入网格的正解。
  const columns = Math.min(3, images.length)
  const rows = Math.ceil(images.length / columns)
  const inputs = []
  for (const image of images) {
    inputs.push("-i", image)
  }
  const portrait = Number(args.height) > Number(args.width)
  const tileWidth = portrait ? 240 : 426
  const tileHeight = portrait ? 426 : 240
  const parts = []
  for (let idx = 0; idx < images.length; idx += 1) {
    parts.push(
      `[${idx}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[t${idx}]`
    )
  }
  const rowLabels = []
  // 不满一行的最后一行用透明 pad 填充，让 hstack 输入数稳定为 columns
  for (let row = 0; row < rows; row += 1) {
    const start = row * columns
    const cellsInRow = Math.min(columns, images.length - start)
    const padCount = columns - cellsInRow
    const inputsForRow = []
    for (let cell = 0; cell < cellsInRow; cell += 1) {
      inputsForRow.push(`[t${start + cell}]`)
    }
    for (let pad = 0; pad < padCount; pad += 1) {
      // 用 color filter 生成同尺寸的灰底占位
      parts.push(
        `color=c=0xf6f7f4:s=${tileWidth}x${tileHeight}:d=0.04,setsar=1[blank${row}_${pad}]`
      )
      inputsForRow.push(`[blank${row}_${pad}]`)
    }
    if (columns > 1) {
      parts.push(`${inputsForRow.join("")}hstack=inputs=${columns}[row${row}]`)
      rowLabels.push(`[row${row}]`)
    } else {
      rowLabels.push(inputsForRow[0])
    }
  }
  if (rows > 1) {
    parts.push(`${rowLabels.join("")}vstack=inputs=${rows}[out]`)
  } else {
    parts.push(`${rowLabels[0]}null[out]`)
  }
  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    outPath
  ])
}

try {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const selectedFrame = path.join(tempDir, "selected-frame.png")
  await extractFrame(videoPath, selectedTime, selectedFrame)
  await renderCoverDispatch(selectedFrame, outputPath)

  let candidates = null
  if (args.candidatesDir) {
    const candidatesDir = path.resolve(args.candidatesDir)
    await prepareCandidatesDir(candidatesDir)
    await mkdir(candidatesDir, { recursive: true })
    const candidateImages = []
    const candidateMeta = []
    for (const [index, ratio] of CANDIDATE_RATIOS.entries()) {
      const seconds = Math.max(0, Math.min(durationSeconds - 0.1, durationSeconds * ratio))
      const frame = path.join(candidatesDir, `candidate-${String(index + 1).padStart(2, "0")}-frame.png`)
      const cover = path.join(candidatesDir, `candidate-${String(index + 1).padStart(2, "0")}-cover.png`)
      await extractFrame(videoPath, seconds, frame)
      await renderCoverDispatch(frame, cover)
      candidateImages.push(cover)
      candidateMeta.push({ index: index + 1, ratio, seconds, frame, cover })
    }
    const contactSheet = path.join(candidatesDir, "contact-sheet.png")
    await makeContactSheetDispatch(candidateImages, contactSheet)
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
        renderer,
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
  if (browser) await browser.close()
  if (!args.keepTemp) await rm(tempDir, { recursive: true, force: true })
}
