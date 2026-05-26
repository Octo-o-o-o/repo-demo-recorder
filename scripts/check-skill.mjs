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
    "scripts/templates/playwright-runner.mjs",
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
    // playwright-runner.mjs 是模板，但替换占位符前是合法 JS（占位符是字符串字面量），
    // 这里把它当普通脚本做语法检查，能及时发现模板被人手改坏。
    "scripts/templates/playwright-runner.mjs",
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
      "--base-url",
      "http://127.0.0.1:5173",
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
    // 死字段 server.port 已被移除（runner 只用 baseUrl）
    if (Object.prototype.hasOwnProperty.call(scenario.server || {}, "port")) {
      fail("Scaffold should not write deprecated scenario.server.port field")
    }
    // customer-ready 正式交付应默认启用 TTS
    if (!scenario.narration?.enabled) {
      fail("Scaffold should enable narration by default for customer-ready audience")
    }
    // 中文 audience=customer 时 cover.title 应该是中文，不再是 hardcode "Product Demo"
    if (scenario.cover?.title === "Product Demo") {
      fail("Scaffold should localize cover.title for zh-CN customer demos")
    }

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
      "--base-url",
      "http://127.0.0.1:5173",
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

    // trim-video-gap 不传 --cover 时也应自动保留源 attached_pic 流
    const trimmedNoCover = path.join(tempRoot, "trimmed-no-cover.mp4")
    run("node", [
      "scripts/trim-video-gap.mjs",
      "--video",
      outputVideo,
      "--out",
      trimmedNoCover,
      "--remove-start-ms",
      "500",
      "--remove-end-ms",
      "700"
    ])
    run("node", [
      "scripts/validate-recording-report.mjs",
      reportPath,
      "--video",
      trimmedNoCover,
      "--require-cover-art"
    ])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkNarrationAndPolishSmoke() {
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    console.warn("[check] skipping narration/polish smoke because ffmpeg/ffprobe is unavailable")
    return
  }
  if (!commandExists("say")) {
    console.warn("[check] skipping narration smoke because macOS `say` is unavailable")
    return
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-narration-"))
  try {
    const sourceVideo = path.join(tempRoot, "source.mp4")
    const reportPath = path.join(tempRoot, "narration-report.json")
    const narratedVideo = path.join(tempRoot, "narrated.mp4")
    const polishedVideo = path.join(tempRoot, "polished.mp4")

    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=320x180:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      sourceVideo
    ])
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "narration-smoke",
          captions: [
            { title: "首页", body: "客户从首页进入。", startMs: 200, endMs: 1800, kind: "caption" },
            { title: "下一步", body: "确认操作并继续。", startMs: 2000, endMs: 3800, kind: "caption" }
          ],
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
      "scripts/add-tts-narration.mjs",
      "--video",
      sourceVideo,
      "--report",
      reportPath,
      "--out",
      narratedVideo,
      "--engine",
      "macos-say",
      "--voice",
      "Tingting",
      "--pad-mode",
      "freeze",
      "--pad-buffer-ms",
      "200"
    ])
    if (!existsSync(narratedVideo)) fail("Narration smoke did not produce narrated mp4")
    if (!existsSync(`${narratedVideo.replace(/\.[^.]+$/, "")}-narration.vtt`)) {
      fail("Narration smoke did not produce VTT")
    }

    run("node", ["scripts/polish-video.mjs", "--video", narratedVideo, "--out", polishedVideo, "--preset", "qa-proof"])
    if (!existsSync(polishedVideo)) fail("Polish smoke did not produce polished mp4")

    // polish 后封面流必须保留——历史上这里是丢封面的死路径
    const coverForPolish = path.join(tempRoot, "polish-cover.png")
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=320x180",
      "-frames:v",
      "1",
      coverForPolish
    ])
    const narratedWithCover = path.join(tempRoot, "narrated-with-cover.mp4")
    run("node", [
      "scripts/embed-video-cover.mjs",
      "--video",
      narratedVideo,
      "--cover",
      coverForPolish,
      "--out",
      narratedWithCover
    ])
    const polishedWithCover = path.join(tempRoot, "polished-with-cover.mp4")
    run("node", [
      "scripts/polish-video.mjs",
      "--video",
      narratedWithCover,
      "--out",
      polishedWithCover,
      "--preset",
      "qa-proof"
    ])
    // 校验 polish 后视频里仍有 attached_pic
    const polishedReport = path.join(tempRoot, "polished-cover-report.json")
    await writeFile(
      polishedReport,
      `${JSON.stringify({
        scenario: "polish-cover",
        captions: [],
        steps: [{ label: "start", highlightVisible: false, overflow: 0 }],
        consoleMessages: [],
        pageErrors: [],
        responseErrors: []
      }, null, 2)}\n`
    )
    run("node", [
      "scripts/validate-recording-report.mjs",
      polishedReport,
      "--video",
      polishedWithCover,
      "--require-cover-art"
    ])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkAvoidVisibleTermsSmoke() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-avoid-"))
  try {
    const reportPath = path.join(tempRoot, "report.json")
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "avoid-terms",
          narrative: { avoidVisibleTerms: ["mock", "dev warning"] },
          captions: [
            { title: "首页", body: "面向客户的工作台总览。", kind: "caption" },
            { title: "演示数据", body: "为了演示效果，这里用了 mock 数据。", kind: "caption" }
          ],
          steps: [{ label: "start", highlightVisible: false, overflow: 0 }],
          consoleMessages: [],
          pageErrors: [],
          responseErrors: []
        },
        null,
        2
      )}\n`
    )
    const result = spawnSync(
      "node",
      ["scripts/validate-recording-report.mjs", reportPath],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (result.status === 0) {
      fail("validate-recording-report should fail when captions hit narrative.avoidVisibleTerms")
    }
    if (!(result.stdout + result.stderr).includes("avoidVisibleTerms")) {
      fail("validate-recording-report should print the term that violated narrative.avoidVisibleTerms")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkProjectDetectionSmoke() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-detect-"))
  try {
    // 模拟一个 Tauri 项目，让 scaffold 自动检测 devUrl 和 packageManager
    await mkdir(path.join(tempRoot, "src-tauri"), { recursive: true })
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        { name: "demo-tauri", scripts: { dev: "vite" }, devDependencies: { vite: "^5" } },
        null,
        2
      )
    )
    await writeFile(path.join(tempRoot, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n")
    await writeFile(
      path.join(tempRoot, "src-tauri/tauri.conf.json"),
      JSON.stringify(
        {
          build: {
            devUrl: "http://localhost:1420",
            beforeDevCommand: "pnpm dev"
          }
        },
        null,
        2
      )
    )
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root",
      tempRoot,
      "--name",
      "auto-detect",
      "--audience",
      "qa-proof",
      "--polish",
      "quick-proof",
      "--flows",
      "core",
      "--force"
    ])
    const scenario = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/auto-detect.scenario.json"), "utf8")
    )
    if (scenario.baseUrl !== "http://localhost:1420") {
      fail(`Project detection should set baseUrl from tauri.conf.json devUrl, got ${scenario.baseUrl}`)
    }
    if (scenario.server?.command !== "pnpm dev") {
      fail(`Project detection should pick pnpm dev from tauri.conf.json/pnpm-lock, got "${scenario.server?.command}"`)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkNpmRunDevSmoke() {
  // npm 项目必须输出 "npm run dev" 而不是 "npm dev"（后者是 invalid command）
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-npm-"))
  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo-npm-next",
          scripts: { dev: "next dev -p 4100" },
          dependencies: { next: "^16" }
        },
        null,
        2
      )
    )
    await writeFile(path.join(tempRoot, "package-lock.json"), "{}\n")
    await writeFile(path.join(tempRoot, "next.config.ts"), "export default {}\n")
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root",
      tempRoot,
      "--name",
      "npm-detect",
      "--audience",
      "qa-proof",
      "--polish",
      "quick-proof",
      "--flows",
      "core",
      "--force"
    ])
    const scenario = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/npm-detect.scenario.json"), "utf8")
    )
    if (scenario.server?.command !== "npm run dev") {
      fail(
        `npm 项目的 dev command 应该是 "npm run dev"，得到："${scenario.server?.command}"。检查 detection.devCommand 的拼接逻辑。`
      )
    }
    // -p 4100 应被 detection 解析，baseUrl 用 4100 而不是 Next 默认 3000
    if (scenario.baseUrl !== "http://localhost:4100") {
      fail(
        `next dev -p 4100 应解析出 port=4100，得到 baseUrl="${scenario.baseUrl}"。检查 detection 的 -p/--port 解析。`
      )
    }
    // 写入型 flow 默认不要 requireDbAssertions=true，否则用户必 fail
    if (scenario.qualityGates?.requireDbAssertions !== false) {
      fail(
        "scaffold 默认应让 requireDbAssertions=false；只有用户自己在 step 里写 type=='db' 断言才打开。"
      )
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkScaffoldInvalidArgs() {
  // 拼错 audience/polish/language/subtitles 时 scaffold 应快速失败，而不是写出无效的 scenario
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-invalid-"))
  try {
    const result = spawnSync(
      "node",
      [
        "scripts/scaffold-repo-demo.mjs",
        "--root",
        tempRoot,
        "--name",
        "invalid",
        "--audience",
        "customers",
        "--flows",
        "core",
        "--force"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (result.status === 0) {
      fail("scaffold 应该拒绝拼错的 --audience customers，但未失败")
    }
    if (!(result.stdout + result.stderr).includes("--audience")) {
      fail("scaffold 拒绝错误 audience 时应该提示有效取值列表")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkCoverLocalizationSmoke() {
  // 中文 report 时 generate-video-cover 的 fallback 文案应自动用中文
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    console.warn("[check] skipping cover localization smoke because ffmpeg/ffprobe is unavailable")
    return
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-cover-i18n-"))
  try {
    const sourceVideo = path.join(tempRoot, "source.mp4")
    const coverOut = path.join(tempRoot, "cover.png")
    const reportPath = path.join(tempRoot, "report.json")
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=640x360:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      sourceVideo
    ])
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "cover-i18n",
          language: "zh-CN",
          captions: [{ title: "首页", body: "欢迎来到产品演示。", startMs: 100, endMs: 1500 }],
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
      "scripts/generate-video-cover.mjs",
      "--video",
      sourceVideo,
      "--report",
      reportPath,
      "--out",
      coverOut,
      "--width",
      "640",
      "--height",
      "360"
    ])
    const coverReport = JSON.parse(
      await readFile(coverOut.replace(/\.png$/, "-cover-report.json"), "utf8")
    )
    if (!/[一-龥]/.test(coverReport.text?.title || "")) {
      fail(
        `中文 report 时 generate-video-cover 的 title fallback 应该是中文，得到："${coverReport.text?.title}"`
      )
    }
    if (!/[一-龥]/.test(coverReport.text?.subtitle || "")) {
      fail(
        `中文 report 时 generate-video-cover 的 subtitle fallback 应该是中文，得到："${coverReport.text?.subtitle}"`
      )
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

await checkRequiredFiles()
await checkSkillFrontmatter()
await checkScriptSyntax()
await checkScaffoldSmoke()
await checkProjectDetectionSmoke()
await checkNpmRunDevSmoke()
await checkScaffoldInvalidArgs()
await checkCoverLocalizationSmoke()
await checkAvoidVisibleTermsSmoke()
await checkReviewAndHandoffSmoke()
await checkEmbedCoverSmoke()
await checkNarrationAndPolishSmoke()

if (process.exitCode) {
  process.exit(process.exitCode)
}

console.log("[check] repo-demo-recorder skill checks passed")
