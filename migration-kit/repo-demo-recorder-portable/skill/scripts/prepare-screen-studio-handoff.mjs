#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

const DEFAULTS = {
  out: null,
  name: "demo",
  target: "desktop",
  video: [],
  rawVideo: null,
  narratedVideo: null,
  report: null,
  scenario: null,
  vtt: null,
  cover: null,
  frameReview: null,
  coverCandidates: null,
  notes: null
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/prepare-screen-studio-handoff.mjs --out <dir> [options]

Options:
  --name <name>                Handoff name
  --target <kind>              desktop | mobile | social | training
  --video <path>               Video asset; may be repeated
  --raw-video <path>           Clean/raw video preferred for Screen Studio editing
  --narrated-video <path>      Narrated final video
  --report <path>              Recording report JSON
  --scenario <path>            Scenario JSON
  --vtt <path>                 Transcript/subtitle VTT
  --cover <path>               Cover PNG
  --frame-review <dir>         Frame review directory
  --cover-candidates <dir>     Cover candidates directory
  --notes <text>               Extra handoff notes
`)
    process.exit(0)
  }

  const args = { ...DEFAULTS, video: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`)
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    if (key === "video") args.video.push(value)
    else args[key] = value
    index += 1
  }

  if (!args.out) throw new Error("Missing --out <dir>")
  return args
}

function slugify(value) {
  return (
    String(value || "demo")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || "demo"
  )
}

async function readJsonMaybe(filePath) {
  if (!filePath || !existsSync(path.resolve(filePath))) return null
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"))
}

async function copyAsset(outDir, label, filePath, usedNames) {
  if (!filePath) return null
  const absolute = path.resolve(filePath)
  if (!existsSync(absolute)) return null
  const assetsDir = path.join(outDir, "assets")
  await mkdir(assetsDir, { recursive: true })
  const parsed = path.parse(absolute)
  let filename = `${slugify(label)}-${parsed.base}`
  let counter = 2
  while (usedNames.has(filename)) {
    filename = `${slugify(label)}-${counter}-${parsed.base}`
    counter += 1
  }
  usedNames.add(filename)
  const dest = path.join(assetsDir, filename)
  await copyFile(absolute, dest)
  return {
    label,
    source: absolute,
    file: path.relative(outDir, dest).split(path.sep).join("/")
  }
}

function targetSettings(target) {
  if (target === "mobile" || target === "social") {
    return {
      aspectRatio: "Vertical 9:16",
      output: "1080x1920 MP4",
      zoom: "Use Screen Studio zoom sparingly; for true iOS device recordings, manual zoom or tap indicators are more reliable than automatic zoom."
    }
  }
  if (target === "training") {
    return {
      aspectRatio: "Wide 16:9 or original app aspect ratio",
      output: "1920x1080 MP4",
      zoom: "Use focused zooms for fields, menus, and keyboard shortcuts; keep longer pauses than a sales demo."
    }
  }
  return {
    aspectRatio: "Wide 16:9",
    output: "1920x1080 MP4",
    zoom: "Use automatic zoom on click-heavy moments and manual zoom for result pages where no click occurs."
  }
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|")
}

function assetTable(assets) {
  if (!assets.length) return "_No assets were copied._"
  return `| Asset | File | Source |\n| --- | --- | --- |\n${assets
    .map((asset) => `| ${mdEscape(asset.label)} | \`${mdEscape(asset.file)}\` | \`${mdEscape(asset.source)}\` |`)
    .join("\n")}`
}

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(args.out)
await mkdir(outDir, { recursive: true })

const usedNames = new Set()
const assetInputs = [
  ["raw-video", args.rawVideo],
  ["narrated-video", args.narratedVideo],
  ...args.video.map((file, index) => [`video-${index + 1}`, file]),
  ["report", args.report],
  ["scenario", args.scenario],
  ["vtt", args.vtt],
  ["cover", args.cover],
  ["frame-review", args.frameReview ? path.join(args.frameReview, "contact-sheet.png") : null],
  ["cover-candidates", args.coverCandidates ? path.join(args.coverCandidates, "contact-sheet.png") : null]
]

const assets = []
for (const [label, filePath] of assetInputs) {
  const copied = await copyAsset(outDir, label, filePath, usedNames)
  if (copied) assets.push(copied)
}

const report = await readJsonMaybe(args.report)
const scenario = await readJsonMaybe(args.scenario)
const settings = targetSettings(args.target)
const manifest = {
  createdAt: new Date().toISOString(),
  name: args.name,
  target: args.target,
  settings,
  reportSummary: report
    ? {
        scenario: report.scenario || report.name || null,
        surface: report.surface || scenario?.primarySurface || scenario?.surface || null,
        captions: Array.isArray(report.captions) ? report.captions.length : 0,
        steps: Array.isArray(report.steps) ? report.steps.length : 0
      }
    : null,
  assets,
  notes: args.notes || null
}

const markdown = `# Screen Studio Handoff

## Intent

Use this pack when the repository-native recorder has produced stable raw footage, subtitles, reports, and cover candidates, but the final deliverable needs Screen Studio-level polish: natural zooms, cursor smoothing, device frames, manual timeline edits, or high-end branded backgrounds.

## Recommended Screen Studio Settings

- Target: \`${args.target}\`
- Aspect ratio: \`${settings.aspectRatio}\`
- Output: \`${settings.output}\`
- Zoom guidance: ${settings.zoom}

## Import Order

1. Import the clean raw video first when you plan to use Screen Studio zooms/cursor effects.
2. Import the narrated video only when you want Screen Studio mainly for background, crop, or export polish.
3. Import or recreate captions from the VTT/transcript. Avoid burning duplicate open captions and Screen Studio captions at the same time.
4. Apply background, padding, rounded corners, and device frame only after deciding the final aspect ratio.
5. Export one final MP4, then run repo-demo-recorder validation again if the video will be committed or shared externally.

## What To Keep In The Skill

- Scenario, seed/mock data, reproducible browser automation, API/DB assertions, report JSON, subtitles, TTS transcript, and review page.

## What To Do In Screen Studio

- Natural cursor smoothing, motion blur, manual zoom blending, device mockups, webcam/camera layouts, background music, and subjective timeline edits.

## Assets

${assetTable(assets)}

## Notes

${args.notes ? args.notes : "_No extra notes._"}
`

await writeFile(path.join(outDir, "screen-studio-handoff.json"), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(path.join(outDir, "SCREEN_STUDIO_HANDOFF.md"), markdown)

console.log(`Generated Screen Studio handoff: ${path.join(outDir, "SCREEN_STUDIO_HANDOFF.md")}`)
