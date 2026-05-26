#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const DEFAULTS = {
  report: null,
  out: null,
  video: null,
  sourceVideo: null,
  mediaReport: null,
  narrationReport: null,
  cover: null,
  coverCandidates: null,
  frameReview: null,
  title: null
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/generate-review-page.mjs --report <report.json> --out <review.html> [options]

Options:
  --video <path>              Final video to review
  --source-video <path>       Raw/source video
  --media-report <path>       JSON from validate-recording-report
  --narration-report <path>   JSON from add-tts-narration
  --cover <path>              Final cover PNG
  --cover-candidates <dir>    Directory containing contact-sheet.png
  --frame-review <dir>        Directory containing contact-sheet.png/frame-review.json
  --title <text>              Review page title
`)
    process.exit(0)
  }

  const args = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`)
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    args[key] = value
    index += 1
  }

  if (!args.report) throw new Error("Missing --report <report.json>")
  if (!args.out) throw new Error("Missing --out <review.html>")
  return args
}

async function readJsonMaybe(filePath) {
  if (!filePath) return null
  const resolved = path.resolve(filePath)
  if (!existsSync(resolved)) return null
  try {
    const text = await readFile(resolved, "utf8")
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch (error) {
    console.warn(`[review] Ignoring unreadable JSON ${filePath}: ${error.message}`)
    return null
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function toHref(targetPath, outPath) {
  if (!targetPath) return null
  const absolute = path.resolve(targetPath)
  if (!existsSync(absolute)) return null
  const relative = path.relative(path.dirname(path.resolve(outPath)), absolute)
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return encodeURI(relative.split(path.sep).join("/"))
  }
  return pathToFileURL(absolute).href
}

function formatMs(value) {
  const ms = Number(value || 0)
  const seconds = Math.floor(ms / 1000)
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`
}

function statusBadge(label, ok) {
  return `<span class="badge ${ok ? "ok" : "fail"}">${htmlEscape(label)}</span>`
}

function renderFailures(mediaReport, report) {
  const failures = []
  if (mediaReport?.failures) failures.push(`${mediaReport.failures} media/report gate failure(s)`)
  if (Array.isArray(report.pageErrors) && report.pageErrors.length) failures.push(`${report.pageErrors.length} page error(s)`)
  if (Array.isArray(report.responseErrors) && report.responseErrors.length) failures.push(`${report.responseErrors.length} response error(s)`)
  if (Array.isArray(report.consoleMessages)) {
    const errors = report.consoleMessages.filter((item) => item?.type === "error")
    if (errors.length) failures.push(`${errors.length} console error(s)`)
  }
  if (failures.length === 0) return `<p class="muted">No blocking issues recorded in the supplied reports.</p>`
  return `<ul>${failures.map((item) => `<li>${htmlEscape(item)}</li>`).join("")}</ul>`
}

function renderCaptions(captions) {
  if (!Array.isArray(captions) || captions.length === 0) {
    return `<p class="muted">No captions found.</p>`
  }
  return `<table>
    <thead><tr><th>#</th><th>Time</th><th>Kind</th><th>Title</th><th>Body</th></tr></thead>
    <tbody>
      ${captions
        .map(
          (cue, index) =>
            `<tr><td>${index + 1}</td><td>${formatMs(cue.startMs ?? cue.atMs)} - ${formatMs(cue.endMs ?? (cue.startMs || cue.atMs || 0) + (cue.durationMs || 0))}</td><td>${htmlEscape(cue.kind || "caption")}</td><td>${htmlEscape(cue.title || "")}</td><td>${htmlEscape(cue.body || "")}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>`
}

function renderAssetCard(title, href, kind = "image", options = {}) {
  if (!href) return `<p class="muted">Missing ${htmlEscape(title)}.</p>`
  const safeHref = htmlEscape(href)
  if (kind === "video") {
    const poster = options.poster ? ` poster="${htmlEscape(options.poster)}"` : ""
    return `<video src="${safeHref}" controls playsinline${poster}></video><p><a href="${safeHref}">${htmlEscape(title)}</a></p>`
  }
  return `<a href="${safeHref}"><img src="${safeHref}" alt="${htmlEscape(title)}"></a><p><a href="${safeHref}">${htmlEscape(title)}</a></p>`
}

function renderJsonBlock(title, json) {
  if (!json) return ""
  return `<details><summary>${htmlEscape(title)}</summary><pre>${htmlEscape(JSON.stringify(json, null, 2))}</pre></details>`
}

const args = parseArgs(process.argv.slice(2))
const reportPath = path.resolve(args.report)
const outPath = path.resolve(args.out)
const report = JSON.parse(await readFile(reportPath, "utf8"))
const mediaReport = await readJsonMaybe(args.mediaReport)
const narrationReport = await readJsonMaybe(args.narrationReport)
const frameReviewJson = await readJsonMaybe(args.frameReview ? path.join(args.frameReview, "frame-review.json") : null)
const coverCandidatesJson = await readJsonMaybe(args.coverCandidates ? path.join(args.coverCandidates, "cover-candidates.json") : null)

const finalVideoHref = toHref(args.video || report.video || report.mp4, outPath)
const sourceVideoHref = toHref(args.sourceVideo || report.webm, outPath)
const coverHref = toHref(args.cover, outPath)
const coverSheetHref = toHref(args.coverCandidates ? path.join(args.coverCandidates, "contact-sheet.png") : null, outPath)
const frameSheetHref = toHref(args.frameReview ? path.join(args.frameReview, "contact-sheet.png") : null, outPath)
const title = args.title || `${report.title || report.scenario || report.name || "Demo"} Review`

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    :root{color-scheme:light;--bg:#f6f7f4;--ink:#17211b;--muted:#66746b;--line:#d9dfd8;--card:#fff;--accent:#1d6f42;--bad:#b42318}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{padding:28px 32px 20px;border-bottom:1px solid var(--line);background:#fff}
    h1{margin:0 0 8px;font-size:28px;letter-spacing:0}
    h2{margin:0 0 14px;font-size:18px}
    a{color:var(--accent)}
    main{display:grid;grid-template-columns:minmax(360px,1.1fr) minmax(320px,.9fr);gap:18px;padding:20px 24px 32px}
    section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;box-shadow:0 10px 28px rgba(23,33,27,.05)}
    video,img{width:100%;max-height:72vh;object-fit:contain;border-radius:6px;background:#111}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    .badge{display:inline-flex;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:700}
    .badge.ok{background:#e5f4ea;color:#146232}
    .badge.fail{background:#fde8e6;color:var(--bad)}
    .muted{color:var(--muted)}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
    th{color:#526057;background:#f8faf7}
    details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
    summary{cursor:pointer;font-weight:700}
    pre{overflow:auto;background:#111a14;color:#e9f5eb;border-radius:6px;padding:12px}
    @media (max-width: 960px){main{grid-template-columns:1fr;padding:14px}.grid{grid-template-columns:1fr}header{padding:22px 18px}}
  </style>
</head>
<body>
  <header>
    <h1>${htmlEscape(title)}</h1>
    <div class="muted">${htmlEscape(report.scenario || report.name || "unknown")} · ${htmlEscape(report.surface || "desktop")} · ${htmlEscape(report.language || "")}</div>
    <div class="badges">
      ${statusBadge("page errors", !(Array.isArray(report.pageErrors) && report.pageErrors.length))}
      ${statusBadge("response errors", !(Array.isArray(report.responseErrors) && report.responseErrors.length))}
      ${statusBadge("media gates", !(mediaReport?.failures > 0))}
      ${statusBadge("captions", Array.isArray(report.captions) && report.captions.length > 0)}
    </div>
  </header>
  <main>
    <section>
      <h2>Final Video</h2>
      ${renderAssetCard("Final video", finalVideoHref, "video", { poster: coverHref })}
      ${sourceVideoHref ? `<details><summary>Source video</summary>${renderAssetCard("Source video", sourceVideoHref, "video")}</details>` : ""}
    </section>
    <section>
      <h2>Quality Summary</h2>
      ${renderFailures(mediaReport, report)}
      ${renderJsonBlock("Media report", mediaReport)}
      ${renderJsonBlock("Narration report", narrationReport)}
    </section>
    <section>
      <h2>Cover</h2>
      ${renderAssetCard("Final cover", coverHref)}
      ${coverSheetHref ? `<details open><summary>Cover candidates</summary>${renderAssetCard("Cover candidates", coverSheetHref)}</details>` : ""}
      ${renderJsonBlock("Cover candidates JSON", coverCandidatesJson)}
    </section>
    <section>
      <h2>Frame Review</h2>
      ${renderAssetCard("Frame review contact sheet", frameSheetHref)}
      ${renderJsonBlock("Frame review JSON", frameReviewJson)}
    </section>
    <section style="grid-column:1/-1">
      <h2>Caption Timeline</h2>
      ${renderCaptions(report.captions)}
      ${renderJsonBlock("Raw report", report)}
    </section>
  </main>
</body>
</html>`

await mkdir(path.dirname(outPath), { recursive: true })
await writeFile(outPath, html)
console.log(`Generated review page: ${outPath}`)
