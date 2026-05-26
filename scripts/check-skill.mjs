#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), "..")

function fail(message) {
  console.error(`[check] ${message}`)
  process.exitCode = 1
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`)
  }
  return result
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  return result.status === 0
}

async function checkRequiredFiles() {
  for (const filePath of [
    "SKILL.md",
    "agents/openai.yaml",
    "references/options.md",
    "references/quality-gates.md",
    "references/scenario-schema.md",
    "scripts/scaffold-repo-demo.mjs",
    "scripts/add-tts-narration.mjs",
    "scripts/generate-video-cover.mjs",
    "scripts/embed-video-cover.mjs",
    "scripts/trim-video-gap.mjs",
    "scripts/generate-review-page.mjs",
    "scripts/polish-video.mjs",
    "scripts/prepare-screen-studio-handoff.mjs",
    "scripts/validate-recording-report.mjs",
    "scripts/install-skill.mjs"
  ]) {
    if (!existsSync(path.join(repoRoot, filePath))) fail(`Missing required file: ${filePath}`)
  }
}

async function checkSkillFrontmatter() {
  const text = await readFile(path.join(repoRoot, "SKILL.md"), "utf8")
  if (!text.startsWith("---\n")) fail("SKILL.md must start with YAML frontmatter")
  if (!/^name:\s*repo-demo-recorder/m.test(text)) fail("SKILL.md frontmatter must include name: repo-demo-recorder")
  if (!/^description:\s*.+/m.test(text)) fail("SKILL.md frontmatter must include description")
}

async function checkScriptSyntax() {
  for (const filePath of [
    "scripts/scaffold-repo-demo.mjs",
    "scripts/add-tts-narration.mjs",
    "scripts/generate-video-cover.mjs",
    "scripts/embed-video-cover.mjs",
    "scripts/trim-video-gap.mjs",
    "scripts/generate-review-page.mjs",
    "scripts/polish-video.mjs",
    "scripts/prepare-screen-studio-handoff.mjs",
    "scripts/validate-recording-report.mjs",
    "scripts/install-skill.mjs",
    "scripts/check-skill.mjs"
  ]) {
    run("node", ["--check", filePath])
  }
}

async function checkScaffoldSmoke() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-check-"))
  try {
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root",
      tempRoot,
      "--name",
      "customer-demo",
      "--audience",
      "customer",
      "--polish",
      "customer-ready",
      "--flows",
      "core,mobile",
      "--force"
    ])
    run("node", ["--check", path.join(tempRoot, "scripts/recordings/customer-demo.mjs")], {
      cwd: tempRoot
    })
    const scenario = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/customer-demo.scenario.json"), "utf8")
    )
    if (scenario.audience !== "customer") fail("Scaffold did not preserve audience=customer")
    if (scenario.overlay?.animation !== "safe-opacity") fail("Scaffold did not default to safe overlay")
    if (!scenario.review?.writeFrameReview) fail("Scaffold did not enable frame review for customer-ready")

    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root",
      tempRoot,
      "--name",
      "mobile-demo",
      "--surface",
      "mobile",
      "--audience",
      "customer",
      "--polish",
      "customer-ready",
      "--flows",
      "mobile",
      "--force"
    ])
    run("node", ["--check", path.join(tempRoot, "scripts/recordings/mobile-demo.mjs")], {
      cwd: tempRoot
    })
    const mobileScenario = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/mobile-demo.scenario.json"), "utf8")
    )
    if (mobileScenario.primarySurface !== "mobile") fail("Mobile scaffold did not set primarySurface=mobile")
    if (mobileScenario.viewport?.width !== 390 || mobileScenario.viewport?.height !== 844) {
      fail("Mobile scaffold did not set 390x844 viewport")
    }
    if (
      mobileScenario.recording?.videoSize?.width !== 1080 ||
      mobileScenario.recording?.videoSize?.height !== 1920
    ) {
      fail("Mobile scaffold did not set 1080x1920 video size")
    }
    if (mobileScenario.cover?.width !== 1080 || mobileScenario.cover?.height !== 1920) {
      fail("Mobile scaffold did not set 1080x1920 cover size")
    }
    if (mobileScenario.overlay?.captionPosition !== "bottom-center") {
      fail("Mobile scaffold did not use bottom-center captions")
    }
    if (!mobileScenario.device?.isMobile || !mobileScenario.device?.hasTouch) {
      fail("Mobile scaffold did not enable mobile/touch device settings")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkReviewAndHandoffSmoke() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-review-"))
  try {
    const reportPath = path.join(tempRoot, "demo-report.json")
    const mediaReportPath = path.join(tempRoot, "demo-media-report.json")
    await mkdir(path.join(tempRoot, "frame-review"), { recursive: true })
    await mkdir(path.join(tempRoot, "cover-candidates"), { recursive: true })
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "demo",
          surface: "desktop",
          language: "zh-CN",
          captions: [{ title: "首页", body: "客户从这里开始处理工作。", startMs: 0, endMs: 1200 }],
          steps: [{ label: "start", highlightVisible: false, overflow: 0 }],
          consoleMessages: [],
          pageErrors: [],
          responseErrors: []
        },
        null,
        2
      )}\n`
    )
    await writeFile(
      mediaReportPath,
      `${JSON.stringify({ scenario: "demo", failures: 0, media: {} }, null, 2)}\n`
    )
    run("node", [
      "scripts/generate-review-page.mjs",
      "--report",
      reportPath,
      "--media-report",
      mediaReportPath,
      "--out",
      path.join(tempRoot, "review.html")
    ])
    if (!existsSync(path.join(tempRoot, "review.html"))) fail("Review smoke did not create review.html")
    run("node", [
      "scripts/prepare-screen-studio-handoff.mjs",
      "--out",
      path.join(tempRoot, "handoff"),
      "--report",
      reportPath,
      "--target",
      "desktop"
    ])
    if (!existsSync(path.join(tempRoot, "handoff/SCREEN_STUDIO_HANDOFF.md"))) {
      fail("Screen Studio handoff smoke did not create markdown")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkEmbedCoverSmoke() {
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    console.warn("[check] skipping cover embed smoke because ffmpeg/ffprobe is unavailable")
    return
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-cover-"))
  try {
    const sourceVideo = path.join(tempRoot, "source.mp4")
    const cover = path.join(tempRoot, "cover.png")
    const outputVideo = path.join(tempRoot, "with-cover.mp4")
    const trimmedVideo = path.join(tempRoot, "trimmed.mp4")
    const reportPath = path.join(tempRoot, "demo-report.json")

    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=320x180:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=1",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourceVideo
    ])
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360",
      "-frames:v",
      "1",
      cover
    ])
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "cover-smoke",
          captions: [],
          steps: [{ label: "start", highlightVisible: false, overflow: 0 }],
          consoleMessages: [],
          pageErrors: [],
          responseErrors: []
        },
        null,
        2
      )}\n`
    )

    run("node", [
      "scripts/embed-video-cover.mjs",
      "--video",
      sourceVideo,
      "--cover",
      cover,
      "--out",
      outputVideo,
      "--intro-duration-ms",
      "500"
    ])
    run("node", [
      "scripts/validate-recording-report.mjs",
      reportPath,
      "--video",
      outputVideo,
      "--require-audio",
      "--require-cover-art",
      "--expect-width",
      "320",
      "--expect-height",
      "180"
    ])
    run("node", [
      "scripts/trim-video-gap.mjs",
      "--video",
      outputVideo,
      "--cover",
      cover,
      "--out",
      trimmedVideo,
      "--remove-start-ms",
      "500",
      "--remove-end-ms",
      "700"
    ])
    run("node", [
      "scripts/validate-recording-report.mjs",
      reportPath,
      "--video",
      trimmedVideo,
      "--require-audio",
      "--require-cover-art",
      "--expect-width",
      "320",
      "--expect-height",
      "180"
    ])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

await checkRequiredFiles()
await checkSkillFrontmatter()
await checkScriptSyntax()
await checkScaffoldSmoke()
await checkReviewAndHandoffSmoke()
await checkEmbedCoverSmoke()

if (process.exitCode) {
  process.exit(process.exitCode)
}

console.log("[check] repo-demo-recorder skill checks passed")
