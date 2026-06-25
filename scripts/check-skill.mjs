#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, lstatSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), "..")

function printHelpAndExit() {
  console.log(`Usage: node scripts/check-skill.mjs

Run the repo-demo-recorder repository self-check.

Checks:
  - required skill files and Codex metadata
  - package files and CLI bin mappings
  - script syntax
  - scaffold smoke tests
  - media helper smoke tests when ffmpeg/ffprobe are available
  - worktree isolation, install, and documentation consistency

Options:
  -h, --help  Show this help
`)
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelpAndExit()
}

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
    "package.json",
    ".gitignore",
    "agents/openai.yaml",
    "references/options.md",
    "references/quality-gates.md",
    "references/scenario-schema.md",
    "scripts/scaffold-repo-demo.mjs",
    "scripts/templates/playwright-runner.mjs",
    "scripts/add-tts-narration.mjs",
    "scripts/generate-video-cover.mjs",
    "scripts/embed-video-cover.mjs",
    "scripts/assemble-segmented-video.mjs",
    "scripts/trim-video-gap.mjs",
    "scripts/generate-review-page.mjs",
    "scripts/polish-video.mjs",
    "scripts/prepare-screen-studio-handoff.mjs",
    "scripts/validate-recording-report.mjs",
    "scripts/install-skill.mjs",
    "scripts/prepare-recording-worktree.mjs",
    "scripts/cleanup-recording-worktree.mjs"
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

async function checkRepositoryIgnoreRules() {
  const text = await readFile(path.join(repoRoot, ".gitignore"), "utf8")
  if (!/(^|\n)\.claude\/settings\.local\.json(\n|$)/.test(text)) {
    fail(".gitignore should exclude .claude/settings.local.json")
  }
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
    "scripts/assemble-segmented-video.mjs",
    "scripts/trim-video-gap.mjs",
    "scripts/generate-review-page.mjs",
    "scripts/polish-video.mjs",
    "scripts/prepare-screen-studio-handoff.mjs",
    "scripts/validate-recording-report.mjs",
    "scripts/install-skill.mjs",
    "scripts/check-skill.mjs",
    "scripts/prepare-recording-worktree.mjs",
    "scripts/cleanup-recording-worktree.mjs"
  ]) {
    run("node", ["--check", filePath])
  }
}

async function checkPackageBins() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
  const expectedFiles = ["SKILL.md", "README.md", "LICENSE", "agents/", "references/", "scripts/"]
  if (JSON.stringify(pkg.files || []) !== JSON.stringify(expectedFiles)) {
    fail(`package.json files should whitelist only runtime/docs files: ${expectedFiles.join(", ")}`)
  }
  // 元数据：确保 npm 用户能从 metadata 找到源码、issues、关键词
  if (!pkg.repository?.url) {
    fail("package.json 应该声明 repository.url，便于 npm 用户回到源码")
  }
  if (!pkg.homepage) {
    fail("package.json 应该声明 homepage，便于 npm 用户跳转 README")
  }
  if (!pkg.bugs?.url) {
    fail("package.json 应该声明 bugs.url，便于用户报告 issue")
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    fail("package.json 应该声明 keywords，便于 npm 搜索")
  }
  const expectedBins = {
    "repo-demo-scaffold": "./scripts/scaffold-repo-demo.mjs",
    "repo-demo-prepare-worktree": "./scripts/prepare-recording-worktree.mjs",
    "repo-demo-cleanup-worktree": "./scripts/cleanup-recording-worktree.mjs",
    "repo-demo-add-tts": "./scripts/add-tts-narration.mjs",
    "repo-demo-validate": "./scripts/validate-recording-report.mjs",
    "repo-demo-cover": "./scripts/generate-video-cover.mjs",
    "repo-demo-embed-cover": "./scripts/embed-video-cover.mjs",
    "repo-demo-assemble": "./scripts/assemble-segmented-video.mjs",
    "repo-demo-trim-gap": "./scripts/trim-video-gap.mjs",
    "repo-demo-review": "./scripts/generate-review-page.mjs",
    "repo-demo-polish": "./scripts/polish-video.mjs",
    "repo-demo-screen-studio": "./scripts/prepare-screen-studio-handoff.mjs",
    "repo-demo-check": "./scripts/check-skill.mjs",
    "repo-demo-install-skill": "./scripts/install-skill.mjs"
  }
  for (const [binName, filePath] of Object.entries(expectedBins)) {
    if (pkg.bin?.[binName] !== filePath) {
      fail(`package.json bin.${binName} should point to ${filePath}`)
      continue
    }
    const absolute = path.join(repoRoot, filePath)
    if (!existsSync(absolute)) {
      fail(`package.json bin.${binName} points to a missing file: ${filePath}`)
      continue
    }
    const text = await readFile(absolute, "utf8")
    if (!text.startsWith("#!/usr/bin/env node")) {
      fail(`package.json bin.${binName} target must start with a node shebang: ${filePath}`)
    }
    if (process.platform !== "win32" && (statSync(absolute).mode & 0o111) === 0) {
      fail(`package.json bin.${binName} target is not executable: ${filePath}`)
    }
    const helpResult = spawnSync("node", [filePath, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
    if (helpResult.status !== 0) {
      fail(`package.json bin.${binName} target should support --help: ${filePath}`)
    } else if (!/Usage:/.test(helpResult.stdout)) {
      fail(`package.json bin.${binName} --help should print Usage: ${filePath}`)
    }
  }
}

async function checkDocumentationConsistency() {
  const scenarioSchema = await readFile(path.join(repoRoot, "references/scenario-schema.md"), "utf8")
  if (/"port"\s*:/.test(scenarioSchema)) {
    fail("references/scenario-schema.md should not document deprecated scenario.server.port")
  }
  if (!/"mode": "mock"/.test(scenarioSchema)) {
    fail("references/scenario-schema.md should document data.mode")
  }
  if (!/"storageState": null/.test(scenarioSchema)) {
    fail("references/scenario-schema.md should document auth.storageState")
  }

  const commands = await readFile(path.join(repoRoot, "references/commands.md"), "utf8")
  if (!/--data-mode mock/.test(commands)) {
    fail("references/commands.md scaffold examples should pass --data-mode mock explicitly")
  }
  if (!/assemble-segmented-video\.mjs/.test(commands)) {
    fail("references/commands.md should document multi-segment assembly and transition covers")
  }

  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8")
  if (/bin entries for every script/.test(readme)) {
    fail("README.md should not claim package.json has bin entries for every script")
  }
  if (/--data-mode (mock|staging|production)[^`\n]*\.\.\./.test(readme)) {
    fail("README.md data-mode examples should be copy-pasteable, not end in literal ellipses")
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
    if (scenario.segmentation?.transitionCover?.enabled !== "auto") {
      fail("Scaffold should emit segmentation.transitionCover.enabled=auto for formal/customer recordings")
    }
    if (scenario.segmentation?.transitionCover?.durationMs !== 2400) {
      fail(`Scaffold transition cover duration should default to 2400ms, got ${scenario.segmentation?.transitionCover?.durationMs}`)
    }
    if (
      scenario.segmentation?.transitionCover?.fadeInMs !== 180 ||
      scenario.segmentation?.transitionCover?.fadeOutMs !== 380
    ) {
      fail(
        `Scaffold transition cover fade defaults should be 180/380ms, got ${scenario.segmentation?.transitionCover?.fadeInMs}/${scenario.segmentation?.transitionCover?.fadeOutMs}`
      )
    }
    if (scenario.outputs?.segmentTransitionCovers !== true) {
      fail("Scaffold should enable segment transition cover artifacts for formal/customer recordings")
    }
    const guide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/--transition-duration-ms 2400/.test(guide)) {
      fail("RECORDING_GUIDE assemble command should use the 2400ms transition cover default")
    }
    if (!/--transition-fade-in-ms 180/.test(guide) || !/--transition-fade-out-ms 380/.test(guide)) {
      fail("RECORDING_GUIDE assemble command should include transition fade defaults")
    }
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
    // cover.line 不再是 hardcode "首页 · 搜索 · 自动化"；当 flows=core,mobile 时应至少包含 flow labels
    if (scenario.cover?.line === "首页 · 搜索 · 自动化") {
      fail("Scaffold cover.line should be derived from --flows, not the legacy hardcoded preset")
    }
    if (!scenario.cover?.line?.includes("核心浏览路径")) {
      fail(`Scaffold cover.line should include flow labels (got: "${scenario.cover?.line}")`)
    }
    // flow.surface 应跟 primarySurface 一致；runner 不切 viewport，不一致会误导用户
    for (const flow of scenario.flows || []) {
      if (flow.surface !== scenario.primarySurface) {
        fail(`Scaffold flow "${flow.id}" surface=${flow.surface} should match primarySurface=${scenario.primarySurface}`)
      }
    }
    // 默认 caption.body 不能是 "替换为该流程的真实说明字幕。" 这类占位文案，否则 TTS 会朗读到客户视频里
    for (const flow of scenario.flows || []) {
      if (flow.caption?.body && /替换|补充这一页/.test(flow.caption.body)) {
        fail(`Scaffold flow "${flow.id}" caption.body still contains placeholder text: "${flow.caption.body}"`)
      }
      for (const step of flow.steps || []) {
        if (step.body && /替换|补充这一页/.test(step.body)) {
          fail(`Scaffold step in flow "${flow.id}" still contains placeholder body: "${step.body}"`)
        }
      }
    }
    // style 应跟随 audience；customer audience 应是 sales-demo（而不是历史的 hardcode qa-proof）
    if (scenario.style !== "sales-demo") {
      fail(`Scaffold style should be "sales-demo" for audience=customer, got "${scenario.style}"`)
    }
    // 默认骨架不能再只有 goto+caption+screenshot 三步——历史上这会产出 8s 的 demo，
    // 看起来像 skill 拼接出问题。现在必须至少包含一次 scroll，并保证不少于 6 步。
    for (const flow of scenario.flows || []) {
      const stepTypes = (flow.steps || []).map((step) => step.type)
      if (stepTypes.length < 6) {
        fail(
          `Scaffold flow "${flow.id}" steps too thin (${stepTypes.length}); raw recording would be ~8s. Skeleton must include scroll + multi-caption to give users a 25s+ starting point.`
        )
      }
      if (!stepTypes.includes("scroll")) {
        fail(`Scaffold flow "${flow.id}" skeleton should include at least one scroll step`)
      }
      if (stepTypes.filter((type) => type === "caption").length < 2) {
        fail(`Scaffold flow "${flow.id}" skeleton should include multiple caption steps for narration cadence`)
      }
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
    // en-US 应该生成英文 RECORDING_GUIDE.md，不能仍然是中文
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root",
      tempRoot,
      "--name",
      "en-demo",
      "--language",
      "en-US",
      "--audience",
      "customer",
      "--polish",
      "customer-ready",
      "--flows",
      "core",
      "--base-url",
      "http://127.0.0.1:5173",
      "--force"
    ])
    const enGuide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!enGuide.startsWith("# Recording Guide")) {
      fail(`en-US scaffold should write English RECORDING_GUIDE.md (first line: "${enGuide.split("\n")[0]}")`)
    }
    if (/^- 场景：/m.test(enGuide)) {
      fail("en-US scaffold should not include Chinese section labels in RECORDING_GUIDE.md")
    }
    const enScenario = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/en-demo.scenario.json"), "utf8")
    )
    // en-US 时 title 应使用英文 suffix " recording"
    if (!enScenario.title?.endsWith("recording")) {
      fail(`en-US scaffold scenario.title should end with " recording", got "${enScenario.title}"`)
    }

    // mobile flow + desktop surface 应触发 console.warn（不应 fail；只验证 scenario 仍生成）
    const mixedResult = spawnSync(
      "node",
      [
        "scripts/scaffold-repo-demo.mjs",
        "--root",
        tempRoot,
        "--name",
        "mixed-flow",
        "--surface",
        "desktop",
        "--audience",
        "qa-proof",
        "--polish",
        "quick-proof",
        "--flows",
        "core,mobile",
        "--base-url",
        "http://127.0.0.1:5173",
        "--force"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (mixedResult.status !== 0) {
      fail(`scaffold core,mobile + surface=desktop should succeed but exited ${mixedResult.status}`)
    }
    if (!(mixedResult.stdout + mixedResult.stderr).includes("flow 列表包含")) {
      fail("scaffold should warn when mobile flow is recorded under desktop primarySurface")
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

async function checkSegmentAssemblySmoke() {
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    console.warn("[check] skipping segment assembly smoke because ffmpeg/ffprobe is unavailable")
    return
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-assemble-"))
  try {
    const segmentOne = path.join(tempRoot, "segment-one.mp4")
    const segmentTwo = path.join(tempRoot, "segment-two.mp4")
    const reportOne = path.join(tempRoot, "segment-one-report.json")
    const reportTwo = path.join(tempRoot, "segment-two-report.json")
    const singleOut = path.join(tempRoot, "single-out.mp4")
    const singleReport = path.join(tempRoot, "single-assemble-report.json")
    const assembledOut = path.join(tempRoot, "assembled.mp4")
    const assemblyReport = path.join(tempRoot, "assembled-assemble-report.json")
    const combinedReport = path.join(tempRoot, "assembled-report.json")

    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=320x180:d=0.7",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.7",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      segmentOne
    ])
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=320x180:d=0.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=0.8",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      segmentTwo
    ])
    await writeFile(
      reportOne,
      `${JSON.stringify(
        {
          scenario: "segment-one",
          language: "zh-CN",
          captions: [{ title: "第一段", body: "先看总览。", startMs: 50, endMs: 500 }],
          steps: [{ label: "one", highlightVisible: false, overflow: 0, atMs: 500 }],
          consoleMessages: [],
          pageErrors: [],
          responseErrors: []
        },
        null,
        2
      )}\n`
    )
    await writeFile(
      reportTwo,
      `${JSON.stringify(
        {
          scenario: "segment-two",
          language: "zh-CN",
          captions: [{ title: "第二段", body: "继续演示新增流程。", startMs: 80, endMs: 650 }],
          steps: [{ label: "two", highlightVisible: false, overflow: 0, atMs: 650 }],
          consoleMessages: [],
          pageErrors: [],
          responseErrors: []
        },
        null,
        2
      )}\n`
    )

    run("node", [
      "scripts/assemble-segmented-video.mjs",
      "--out",
      singleOut,
      "--segment",
      segmentOne,
      "--segment-title",
      "第一段",
      "--segment-report",
      reportOne,
      "--report",
      singleReport
    ])
    const singleMeta = JSON.parse(await readFile(singleReport, "utf8"))
    if (singleMeta.transitionCount !== 0 || singleMeta.skippedReason !== "single segment: no intermediate transition cover needed") {
      fail("assemble single segment should not insert transition covers")
    }

    run("node", [
      "scripts/assemble-segmented-video.mjs",
      "--out",
      assembledOut,
      "--segment",
      segmentOne,
      "--segment-title",
      "第一段",
      "--segment-report",
      reportOne,
      "--segment",
      segmentTwo,
      "--segment-title",
      "新增数据流程",
      "--segment-report",
      reportTwo,
      "--transition-duration-ms",
      "400",
      "--report",
      assemblyReport,
      "--combined-report",
      combinedReport
    ])
    const assembly = JSON.parse(await readFile(assemblyReport, "utf8"))
    if (assembly.segmentCount !== 2 || assembly.transitionCount !== 1) {
      fail(`assemble multi segment should insert exactly one transition (got ${assembly.transitionCount})`)
    }
    if (!assembly.transitions?.[0]?.cover || !existsSync(assembly.transitions[0].cover)) {
      fail("assemble multi segment should write a transition cover PNG")
    }
    const merged = JSON.parse(await readFile(combinedReport, "utf8"))
    if (!merged.captions?.some((cue) => cue.kind === "transition" && cue.narration === false)) {
      fail("combined report should include a non-narrated transition cue")
    }
    run("node", [
      "scripts/validate-recording-report.mjs",
      combinedReport,
      "--video",
      assembledOut,
      "--require-audio",
      "--expect-width",
      "320",
      "--expect-height",
      "180"
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

async function checkTtsScenarioSmoke() {
  // scaffold 把 narration.engine / voice 等偏好沉淀到 scenario，但历史上 add-tts-narration.mjs
  // 完全不读 scenario，等于白沉淀。这条 smoke 保证：
  // 1) scaffold 出 customer scenario 时 narration.engine=edge-tts、voice=zh-CN-YunyangNeural
  // 2) generated RECORDING_GUIDE 中 add-tts 命令使用 --scenario 而不是 hardcode --engine
  // 3) add-tts-narration.mjs 接受 --scenario 参数（不实际跑，只看 --help 输出）
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-tts-scenario-"))
  try {
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "tts-default",
      "--data-mode", "mock",
      "--audience", "customer",
      "--polish", "customer-ready",
      "--language", "zh-CN",
      "--flows", "core",
      "--base-url", "http://127.0.0.1:3000",
      "--force"
    ])
    const scenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/tts-default.scenario.json"), "utf8"))
    if (scenario.narration?.engine !== "edge-tts") {
      fail(`customer audience scenario.narration.engine 应为 edge-tts，得到 ${scenario.narration?.engine}`)
    }
    if (scenario.narration?.provider !== "auto") {
      fail(`默认 customer scenario.narration.provider 应为 auto，得到 ${scenario.narration?.provider}`)
    }
    if (scenario.narration?.voice !== "zh-CN-YunyangNeural") {
      fail(`customer + zh-CN scenario.narration.voice 应为 zh-CN-YunyangNeural，得到 ${scenario.narration?.voice}`)
    }
    const guide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    // guide 应让用户用 --scenario，而不是 hardcode --engine edge-tts
    if (!/add-tts-narration\.mjs[^\n]*--scenario/.test(guide)) {
      fail("RECORDING_GUIDE 中 add-tts 命令必须使用 --scenario，把 engine/voice 偏好沉淀在 scenario 里")
    }
    if (/add-tts-narration\.mjs[^\n]*--engine\s+edge-tts/.test(guide)) {
      fail("RECORDING_GUIDE 中 add-tts 命令不应再 hardcode --engine edge-tts；scenario.narration.engine 已经表达了这个选择")
    }
    // add-tts-narration --help 必须列出 --scenario
    const helpResult = spawnSync(
      "node",
      ["scripts/add-tts-narration.mjs", "--help"],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (helpResult.status !== 0) {
      fail("add-tts-narration --help 应返回 0，未返回")
    }
    if (!/--scenario/.test(helpResult.stdout)) {
      fail("add-tts-narration --help 必须列出 --scenario")
    }
    if (!/doubao-tts-v3/.test(helpResult.stdout) || !/DOUBAO_TTS_API_KEY/.test(helpResult.stdout)) {
      fail("add-tts-narration --help 必须列出 doubao-tts-v3 和 DOUBAO_TTS_API_KEY 配置提示")
    }

    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "tts-zh-tw",
      "--data-mode", "mock",
      "--audience", "customer",
      "--polish", "customer-ready",
      "--language", "zh-TW",
      "--flows", "core",
      "--base-url", "http://127.0.0.1:3000",
      "--force"
    ])
    const zhTwScenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/tts-zh-tw.scenario.json"), "utf8"))
    if (zhTwScenario.narration?.voice !== "zh-TW-YunJheNeural") {
      fail(`customer + zh-TW scenario.narration.voice 应为 zh-TW-YunJheNeural，得到 ${zhTwScenario.narration?.voice}`)
    }

    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "tts-doubao",
      "--data-mode", "mock",
      "--audience", "customer",
      "--polish", "customer-ready",
      "--language", "zh-CN",
      "--flows", "core",
      "--base-url", "http://127.0.0.1:3000",
      "--tts-provider", "doubao-tts-v3",
      "--force"
    ])
    const doubaoScenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/tts-doubao.scenario.json"), "utf8"))
    if (doubaoScenario.narration?.provider !== "doubao-tts-v3") {
      fail(`--tts-provider doubao-tts-v3 应写入 narration.provider，得到 ${doubaoScenario.narration?.provider}`)
    }
    if (doubaoScenario.narration?.engine !== "doubao-tts-v3") {
      fail(`--tts-provider doubao-tts-v3 应写入 narration.engine，得到 ${doubaoScenario.narration?.engine}`)
    }
    if (doubaoScenario.narration?.voice !== "zh_female_jitangmei_uranus_bigtts") {
      fail(`Doubao 默认 voice 应为 zh_female_jitangmei_uranus_bigtts，得到 ${doubaoScenario.narration?.voice}`)
    }
    if (doubaoScenario.narration?.doubaoModel !== "seed-tts-2.0-expressive") {
      fail(`Doubao 默认 model 应为 seed-tts-2.0-expressive，得到 ${doubaoScenario.narration?.doubaoModel}`)
    }
    if (Object.prototype.hasOwnProperty.call(doubaoScenario.narration || {}, "doubaoApiKey")) {
      fail("Doubao scenario 不应写入 doubaoApiKey；凭据只能来自 env 或 CLI")
    }
    const doubaoGuide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/DOUBAO_TTS_API_KEY|VOLCENGINE_TTS_API_KEY/.test(doubaoGuide)) {
      fail("Doubao RECORDING_GUIDE 必须提示通过环境变量提供 API key")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkPreflightSmoke() {
  // preflight.steps 让 runner 在录制前 dismiss 首登 modal / PATCH onboardingComplete /
  // 预热演示账号。校验三件事：scaffold emit preflight 占位、guide 提到 preflight、
  // runner template 中保留 runPreflightStep 入口。
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-preflight-"))
  try {
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "preflight-default",
      "--data-mode", "mock",
      "--audience", "customer",
      "--polish", "customer-ready",
      "--flows", "core",
      "--base-url", "http://127.0.0.1:3000",
      "--force"
    ])
    const scenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/preflight-default.scenario.json"), "utf8"))
    if (!scenario.preflight || !Array.isArray(scenario.preflight.steps)) {
      fail("scaffold 必须在 scenario 里 emit preflight.steps（数组占位），便于用户填 dismiss modal 的步骤")
    }
    const guide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/preflight/.test(guide)) {
      fail("RECORDING_GUIDE 必须解释 preflight 用法（关 onboarding modal / PATCH 账号 onboarded 等）")
    }
    if (!/演示账号预热|Demo account warm-up/.test(guide)) {
      fail("RECORDING_GUIDE 必须包含「演示账号预热 / Demo account warm-up」章节")
    }
    if (!/onboardingComplete|onboarding-skip|首登|onboarding modal/i.test(guide)) {
      fail("RECORDING_GUIDE 必须给出具体的预热例子（onboardingComplete fetch、点击 modal）")
    }

    // runner template 自身应能用 preflight 字段（已经在 emit 的 runner 脚本里）。
    const runnerPath = path.join(tempRoot, "scripts/recordings/preflight-default.mjs")
    run("node", ["--check", runnerPath], { cwd: tempRoot })
    const runnerSrc = await readFile(runnerPath, "utf8")
    if (!/runPreflightStep|scenario\.preflight/.test(runnerSrc)) {
      fail("generated runner 应包含 preflight 入口（runPreflightStep 或 scenario.preflight 处理）")
    }
    // preflight 必须仅支持 goto/click/fill/wait/fetch；不能允许 caption/chapter/screenshot/db
    // 这些会污染录制产物的 step 类型在 preflight 段被静默执行。
    if (!/preflight step.*unsupported type/.test(runnerSrc)) {
      fail("runner preflight 段应在遇到不支持的 step type 时 fail-fast（runPreflightStep 错误信息）")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkDataModeSmoke() {
  // 数据来源 / 录制环境（mock|staging|production）是 MUST-ASK 项。
  // 这一组 smoke 覆盖：默认 mock、staging、production 的三种行为，
  // 以及 production 没有 --allow-production 时必须 fail-fast。
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-data-mode-"))
  try {
    // 1) 默认 mock：scenario.data.mode == mock，auth.mode 表达"可走 dev-login"
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "mock-default",
      "--audience", "customer",
      "--polish", "formal-delivery",
      "--flows", "core",
      "--base-url", "http://127.0.0.1:3000",
      "--force"
    ])
    const mockScenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/mock-default.scenario.json"), "utf8"))
    if (mockScenario.data?.mode !== "mock") fail(`默认 scaffold 应当写入 data.mode=mock，得到 ${mockScenario.data?.mode}`)
    if (mockScenario.auth?.mode?.includes("storage-state-required")) {
      fail("mock 模式下 auth.mode 不应该强制 storage-state-required")
    }
    if (mockScenario.data?.productionWarning) {
      fail("mock 模式不应该带 productionWarning")
    }
    const mockGuide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/数据来源：mock|Data Source: Mock/.test(mockGuide)) {
      fail("mock 模式 RECORDING_GUIDE 应当包含『数据来源：mock』章节")
    }

    // 2) staging：data.mode=staging，guide 包含 storageState 引导
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "staging-demo",
      "--data-mode", "staging",
      "--audience", "qa-proof",
      "--polish", "formal-delivery",
      "--flows", "core",
      "--base-url", "https://staging.example.com",
      "--force"
    ])
    const stagingScenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/staging-demo.scenario.json"), "utf8"))
    if (stagingScenario.data?.mode !== "staging") fail(`staging scaffold 应当写入 data.mode=staging，得到 ${stagingScenario.data?.mode}`)
    if (stagingScenario.auth?.mode !== "storage-state-required") {
      fail(`staging 模式 auth.mode 应当是 storage-state-required，得到 ${stagingScenario.auth?.mode}`)
    }
    const stagingGuide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/storageState|storage-state/.test(stagingGuide)) {
      fail("staging RECORDING_GUIDE 必须包含 storageState 准备步骤")
    }

    // 3) production 但没 --allow-production：必须 fail-fast，错误信息提到合规
    const prodNoAllow = spawnSync(
      "node",
      [
        "scripts/scaffold-repo-demo.mjs",
        "--root", tempRoot,
        "--name", "prod-fail",
        "--data-mode", "production",
        "--audience", "customer",
        "--polish", "customer-ready",
        "--flows", "core",
        "--base-url", "https://app.example.com",
        "--force"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (prodNoAllow.status === 0) {
      fail("production 没有 --allow-production 时必须 fail，但成功了")
    }
    if (!(prodNoAllow.stdout + prodNoAllow.stderr).includes("--allow-production")) {
      fail("production fail-fast 时应在错误里提示 --allow-production")
    }

    // 4) production + --allow-production：成功，但 scenario.data.productionWarning 必须存在
    //    strategy 必须强制 readonly，cleanup=false
    run("node", [
      "scripts/scaffold-repo-demo.mjs",
      "--root", tempRoot,
      "--name", "prod-allowed",
      "--data-mode", "production",
      "--allow-production",
      "--audience", "customer",
      "--polish", "customer-ready",
      "--flows", "core,add-data",
      "--base-url", "https://app.example.com",
      "--force"
    ])
    const prodScenario = JSON.parse(await readFile(path.join(tempRoot, "docs/recordings/prod-allowed.scenario.json"), "utf8"))
    if (prodScenario.data?.mode !== "production") {
      fail(`production scaffold 应当写入 data.mode=production，得到 ${prodScenario.data?.mode}`)
    }
    if (prodScenario.data?.strategy !== "readonly") {
      fail(`production 模式必须强制 data.strategy=readonly（即使 flows 含 data 类型），得到 ${prodScenario.data?.strategy}`)
    }
    if (prodScenario.data?.cleanup !== false) {
      fail("production 模式 data.cleanup 必须为 false")
    }
    if (!prodScenario.data?.productionWarning) {
      fail("production scenario 必须带 data.productionWarning 字段")
    }
    const prodGuide = await readFile(path.join(tempRoot, "docs/recordings/RECORDING_GUIDE.md"), "utf8")
    if (!/⚠️/.test(prodGuide) || !/书面授权|written authorization/.test(prodGuide)) {
      fail("production RECORDING_GUIDE 必须包含合规警告（⚠️ + 书面授权）")
    }

    // 5) --allow-production 不带 --data-mode production：应当 fail
    const allowMisuse = spawnSync(
      "node",
      [
        "scripts/scaffold-repo-demo.mjs",
        "--root", tempRoot,
        "--name", "misuse",
        "--data-mode", "mock",
        "--allow-production",
        "--audience", "customer",
        "--polish", "customer-ready",
        "--flows", "core",
        "--base-url", "http://localhost:3000",
        "--force"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (allowMisuse.status === 0) {
      fail("--allow-production 没配合 --data-mode production 时必须 fail")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkConsoleErrorAllowlistSmoke() {
  // allowedConsoleErrors 应当同时匹配 message.text 和 message.location.url；
  // 历史上只匹配 message.text，"Failed to load resource ... 401" 这种 chromium 输出永远命不中
  // "/api/auth/me"，导致用户加白后仍然 fail。
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-console-allow-"))
  try {
    const baseReport = {
      scenario: "console-allow",
      qualityGates: { allowedConsoleErrors: ["/api/auth/me"], allowedResponseErrors: ["/api/auth/me"] },
      captions: [],
      steps: [{ label: "start", highlightVisible: false, overflow: 0 }],
      consoleMessages: [
        {
          type: "error",
          text: "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
          location: { url: "http://localhost:3000/api/auth/me", lineNumber: 0 }
        }
      ],
      pageErrors: [],
      responseErrors: [{ status: 401, url: "http://localhost:3000/api/auth/me", method: "GET" }]
    }
    const reportPath = path.join(tempRoot, "report.json")
    await writeFile(reportPath, `${JSON.stringify(baseReport, null, 2)}\n`)
    const okResult = spawnSync(
      "node",
      ["scripts/validate-recording-report.mjs", reportPath],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (okResult.status !== 0 && !okResult.stdout.includes("录屏质量门禁通过")) {
      // 注意：因为缺少 video 校验，会通过；如果 fail，必须不是 console error 命中导致的
      if ((okResult.stdout + okResult.stderr).includes("未允许的 console error")) {
        fail(
          `validate-recording-report should match allowedConsoleErrors against message.location.url; output:\n${okResult.stdout}\n${okResult.stderr}`
        )
      }
    }

    // 反向：如果 allowlist 不含该 url，则应该 fail，并输出 url 方便诊断
    const strictReport = {
      ...baseReport,
      qualityGates: { allowedConsoleErrors: [], allowedResponseErrors: [] }
    }
    const strictPath = path.join(tempRoot, "strict-report.json")
    await writeFile(strictPath, `${JSON.stringify(strictReport, null, 2)}\n`)
    const failResult = spawnSync(
      "node",
      ["scripts/validate-recording-report.mjs", strictPath],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (failResult.status === 0) {
      fail("validate-recording-report should fail when console errors are not in allowlist")
    }
    if (!(failResult.stdout + failResult.stderr).includes("api/auth/me")) {
      fail(
        "validate-recording-report should print the offending console message url for diagnosis, but did not include /api/auth/me"
      )
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkReviewPageLangSmoke() {
  // review HTML 的 <html lang> 必须跟随 report.language（zh-CN/en-US...），不能硬编码 "en"
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-review-lang-"))
  try {
    const reportPath = path.join(tempRoot, "report.json")
    const outPath = path.join(tempRoot, "review.html")
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          scenario: "review-lang",
          language: "zh-CN",
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
      "scripts/generate-review-page.mjs",
      "--report",
      reportPath,
      "--out",
      outPath
    ])
    const html = await readFile(outPath, "utf8")
    if (!/<html\s+lang="zh-CN">/.test(html)) {
      fail(`review HTML should use lang="zh-CN" when report.language=zh-CN, got: ${html.split("\n", 3)[1]}`)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkTtsArgValidationSmoke() {
  // add-tts-narration.mjs 必须拒绝 --video-crf 超出 0-51 范围（之前不校验，等到 ffmpeg 才抛）
  // 直接传一个虚假 --video 路径也无所谓，因为 args 校验在文件读取之前
  const result = spawnSync(
    "node",
    [
      "scripts/add-tts-narration.mjs",
      "--video",
      "/tmp/does-not-exist.mp4",
      "--report",
      "/tmp/does-not-exist.json",
      "--out",
      "/tmp/does-not-exist-out.mp4",
      "--video-crf",
      "9999"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  )
  if (result.status === 0) {
    fail("add-tts-narration should reject --video-crf 9999")
  }
  if (!(result.stdout + result.stderr).includes("--video-crf")) {
    fail("add-tts-narration should mention --video-crf in the error")
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

async function checkWorktreeIsolationSmoke() {
  // 端到端验证 prepare-recording-worktree.mjs + cleanup-recording-worktree.mjs：
  // 建临时 git 仓库 → 制造 dirty + untracked → prepare → 写 artifact → cleanup →
  // 验证 worktree 删干净、产物拷回主工作树、exclude 注册/移除、symlink 是真的 symlink。
  const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" })
  if (gitCheck.status !== 0) {
    console.warn("[check] skipping worktree isolation smoke because git is unavailable")
    return
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-worktree-"))
  try {
    const gitInit = spawnSync("git", ["init", "-q"], { cwd: tempRoot, encoding: "utf8" })
    if (gitInit.status !== 0) {
      fail(`worktree smoke: git init failed: ${gitInit.stderr}`)
      return
    }
    spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: tempRoot })
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: tempRoot })

    await writeFile(path.join(tempRoot, "README.md"), "# base\n")
    await writeFile(path.join(tempRoot, ".gitignore"), "node_modules/\n")
    await mkdir(path.join(tempRoot, "node_modules", "fake-lib"), { recursive: true })
    await writeFile(
      path.join(tempRoot, "node_modules", "fake-lib", "index.js"),
      "module.exports={}\n"
    )
    await writeFile(path.join(tempRoot, ".env.local"), "API_KEY=demo\n")
    await writeFile(path.join(tempRoot, ".env.production.local"), "PROD_API_KEY=real\n")
    spawnSync("git", ["add", "README.md", ".gitignore"], { cwd: tempRoot })
    const commit = spawnSync("git", ["commit", "-q", "-m", "init"], {
      cwd: tempRoot,
      encoding: "utf8"
    })
    if (commit.status !== 0) {
      fail(`worktree smoke: git commit failed: ${commit.stderr}`)
      return
    }

    // dirty：含 staged/unstaged + untracked，验证 --include-uncommitted 都能搬过去
    await writeFile(path.join(tempRoot, "README.md"), "# base\nmore line\n")
    await writeFile(path.join(tempRoot, "NEW.txt"), "untracked\n")

    const prepareResult = spawnSync(
      "node",
      [
        "scripts/prepare-recording-worktree.mjs",
        "--root",
        tempRoot,
        "--name",
        "smoke",
        "--include-uncommitted"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (prepareResult.status !== 0) {
      fail(
        `prepare-recording-worktree.mjs failed:\nstdout=${prepareResult.stdout}\nstderr=${prepareResult.stderr}`
      )
      return
    }
    const stdoutLines = prepareResult.stdout.trim().split(/\r?\n/)
    const meta = JSON.parse(stdoutLines[stdoutLines.length - 1])
    if (meta.schema !== "repo-demo-recorder/worktree.v1") {
      fail(`prepare metadata schema mismatch: ${meta.schema}`)
      return
    }
    const worktreePath = meta.worktreePath

    if (!existsSync(worktreePath)) {
      fail("prepare did not create worktreePath")
      return
    }
    if (!existsSync(path.join(worktreePath, ".repo-demo-recorder-worktree.json"))) {
      fail("prepare did not write metadata file inside worktree")
      return
    }
    const nodeModulesLink = path.join(worktreePath, "node_modules")
    if (!existsSync(nodeModulesLink) || !lstatSync(nodeModulesLink).isSymbolicLink()) {
      fail("prepare did not symlink node_modules into worktree")
      return
    }
    const envLink = path.join(worktreePath, ".env.local")
    if (!existsSync(envLink) || !lstatSync(envLink).isSymbolicLink()) {
      fail("prepare did not symlink .env.local into worktree")
      return
    }
    if (existsSync(path.join(worktreePath, ".env.production.local"))) {
      fail("prepare should not link or carry .env.production.local by default")
      return
    }
    const carriedReadme = await readFile(path.join(worktreePath, "README.md"), "utf8")
    if (!carriedReadme.includes("more line")) {
      fail("prepare --include-uncommitted did not carry tracked diff")
      return
    }
    if (!existsSync(path.join(worktreePath, "NEW.txt"))) {
      fail("prepare --include-uncommitted did not copy untracked files")
      return
    }
    const excludeText = await readFile(path.join(tempRoot, ".git/info/exclude"), "utf8")
    if (
      !excludeText.split(/\r?\n/).some((line) => line.trim() === "/.repo-demo-recorder/")
    ) {
      fail("prepare did not register /.repo-demo-recorder/ in .git/info/exclude")
      return
    }
    const statusResult = spawnSync("git", ["-C", tempRoot, "status", "--porcelain"], {
      encoding: "utf8"
    })
    if (statusResult.stdout.includes(".repo-demo-recorder")) {
      fail(
        `prepare leaked .repo-demo-recorder into main git status:\n${statusResult.stdout}`
      )
      return
    }

    await mkdir(path.join(worktreePath, "docs/recordings"), { recursive: true })
    await writeFile(path.join(worktreePath, "docs/recordings/smoke.mp4"), "fake")
    await writeFile(
      path.join(worktreePath, "docs/recordings/smoke-report.json"),
      JSON.stringify({ scenario: "smoke" })
    )
    await mkdir(path.join(tempRoot, "docs/recordings"), { recursive: true })
    await writeFile(
      path.join(tempRoot, "docs/recordings/smoke-report.json"),
      JSON.stringify({ scenario: "main-existing" })
    )
    await mkdir(path.join(worktreePath, "scripts/recordings"), { recursive: true })
    await writeFile(path.join(worktreePath, "scripts/recordings/smoke.mjs"), "// runner")

    const cleanupResult = spawnSync(
      "node",
      ["scripts/cleanup-recording-worktree.mjs", "--worktree", worktreePath],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (cleanupResult.status !== 0) {
      fail(
        `cleanup-recording-worktree.mjs failed:\nstdout=${cleanupResult.stdout}\nstderr=${cleanupResult.stderr}`
      )
      return
    }
    if (existsSync(worktreePath)) {
      fail("cleanup did not remove worktreePath")
      return
    }
    if (existsSync(path.join(tempRoot, ".repo-demo-recorder"))) {
      fail("cleanup did not prune .repo-demo-recorder parent dir")
      return
    }
    if (!existsSync(path.join(tempRoot, "docs/recordings/smoke.mp4"))) {
      fail("cleanup did not copy docs/recordings back to main work tree")
      return
    }
    const preservedReport = JSON.parse(
      await readFile(path.join(tempRoot, "docs/recordings/smoke-report.json"), "utf8")
    )
    if (preservedReport.scenario !== "main-existing") {
      fail("cleanup --copy-mode merge should not overwrite existing main work tree files")
      return
    }
    if (!existsSync(path.join(tempRoot, "scripts/recordings/smoke.mjs"))) {
      fail("cleanup did not copy scripts/recordings back to main work tree")
      return
    }
    const excludeAfter = await readFile(path.join(tempRoot, ".git/info/exclude"), "utf8")
    if (
      excludeAfter.split(/\r?\n/).some((line) => line.trim() === "/.repo-demo-recorder/")
    ) {
      fail("cleanup did not remove /.repo-demo-recorder/ from .git/info/exclude")
      return
    }
    const worktreeList = spawnSync(
      "git",
      ["-C", tempRoot, "worktree", "list", "--porcelain"],
      { encoding: "utf8" }
    )
    if (worktreeList.stdout.includes("smoke")) {
      fail(`git worktree list still references smoke after cleanup:\n${worktreeList.stdout}`)
      return
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkWorktreeRejectsNonGit() {
  // 不是 git 仓库时必须 fail-fast，明确告诉用户怎么做。
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-no-git-"))
  try {
    const result = spawnSync(
      "node",
      ["scripts/prepare-recording-worktree.mjs", "--root", tempRoot, "--name", "x"],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (result.status === 0) {
      fail("prepare-recording-worktree.mjs 应该在非 git 仓库下失败")
      return
    }
    if (!(result.stdout + result.stderr).includes("git")) {
      fail("prepare 在非 git 仓库下的错误信息应提到 git，便于用户判断")
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function checkUnknownArgFailFastSmoke() {
  // 任何 scaffold/add-tts-narration/generate-video-cover 接收到拼错的参数都应 fail-fast，
  // 不能默默把 args.audiance="customer" 当成 args.audience 不存在然后用默认值跑。
  const cases = [
    {
      label: "scaffold-repo-demo --audiance",
      cmd: [
        "scripts/scaffold-repo-demo.mjs",
        "--root", repoRoot,
        "--name", "typo-check",
        "--audiance", "customer",
        "--flows", "core"
      ],
      expectInError: /(无法识别参数|--audience)/
    },
    {
      label: "add-tts-narration --engin",
      cmd: [
        "scripts/add-tts-narration.mjs",
        "--video", "/tmp/x.mp4",
        "--report", "/tmp/x.json",
        "--out", "/tmp/y.mp4",
        "--engin", "macos-say"
      ],
      expectInError: /(无法识别参数|--engine)/
    },
    {
      label: "generate-video-cover --titel",
      cmd: [
        "scripts/generate-video-cover.mjs",
        "--video", "/tmp/x.mp4",
        "--out", "/tmp/y.png",
        "--titel", "Wrong"
      ],
      expectInError: /(Unknown argument|--title)/
    }
  ]
  for (const item of cases) {
    const result = spawnSync("node", item.cmd, { cwd: repoRoot, encoding: "utf8" })
    if (result.status === 0) {
      fail(`${item.label} 应该 fail-fast，但是成功了`)
      continue
    }
    if (!item.expectInError.test(result.stdout + result.stderr)) {
      fail(`${item.label} 的错误信息不够清晰，期望匹配 ${item.expectInError}`)
    }
  }
}

async function checkInstallSkillSmoke() {
  // 校验 install-skill.mjs 把 README.md / LICENSE 一并放进安装目录，
  // 这样用户从 ~/.codex/skills/repo-demo-recorder/ 也能直接看到许可与说明。
  const dest = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-install-"))
  try {
    const result = spawnSync(
      "node",
      ["scripts/install-skill.mjs", "--dest", dest, "--force"],
      { cwd: repoRoot, encoding: "utf8" }
    )
    if (result.status !== 0) {
      fail(`install-skill.mjs failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`)
      return
    }
    for (const item of [
      "SKILL.md",
      "README.md",
      "LICENSE",
      "agents/openai.yaml",
      "references/options.md",
      "scripts/scaffold-repo-demo.mjs",
      "scripts/assemble-segmented-video.mjs",
      "scripts/templates/playwright-runner.mjs"
    ]) {
      if (!existsSync(path.join(dest, item))) {
        fail(`install-skill.mjs 没有复制 ${item}（用户的 skill 目录里会看不到）`)
      }
    }
    // --help 必须 exit 0
    const help = spawnSync("node", ["scripts/install-skill.mjs", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    })
    if (help.status !== 0) fail("install-skill.mjs --help 应返回 0")
    if (!/--dry-run/.test(help.stdout)) {
      fail("install-skill.mjs --help 必须列出 --dry-run，便于发现 dry-run 能力")
    }
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
}

async function checkWorktreeRejectsUnsafeRelativePaths() {
  const prepareResult = spawnSync(
    "node",
    [
      "scripts/prepare-recording-worktree.mjs",
      "--root",
      repoRoot,
      "--name",
      "unsafe-link",
      "--link",
      "../outside"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  )
  if (prepareResult.status === 0) {
    fail("prepare-recording-worktree.mjs 应拒绝 --link ../outside")
  }
  if (!/(相对路径|项目根目录内)/.test(prepareResult.stdout + prepareResult.stderr)) {
    fail("prepare 拒绝 unsafe --link 时应说明路径必须留在项目根目录内")
  }

  const cleanupResult = spawnSync(
    "node",
    [
      "scripts/cleanup-recording-worktree.mjs",
      "--worktree",
      "/tmp/does-not-matter",
      "--copy",
      "../outside"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  )
  if (cleanupResult.status === 0) {
    fail("cleanup-recording-worktree.mjs 应拒绝 --copy ../outside")
  }
  if (!/(相对路径|项目根目录内)/.test(cleanupResult.stdout + cleanupResult.stderr)) {
    fail("cleanup 拒绝 unsafe --copy 时应说明路径必须留在项目根目录内")
  }
}

await checkRequiredFiles()
await checkSkillFrontmatter()
await checkRepositoryIgnoreRules()
await checkScriptSyntax()
await checkPackageBins()
await checkDocumentationConsistency()
await checkScaffoldSmoke()
await checkProjectDetectionSmoke()
await checkNpmRunDevSmoke()
await checkScaffoldInvalidArgs()
await checkCoverLocalizationSmoke()
await checkAvoidVisibleTermsSmoke()
await checkDataModeSmoke()
await checkPreflightSmoke()
await checkTtsScenarioSmoke()
await checkConsoleErrorAllowlistSmoke()
await checkReviewPageLangSmoke()
await checkTtsArgValidationSmoke()
await checkReviewAndHandoffSmoke()
await checkEmbedCoverSmoke()
await checkSegmentAssemblySmoke()
await checkNarrationAndPolishSmoke()
await checkWorktreeIsolationSmoke()
await checkWorktreeRejectsNonGit()
await checkWorktreeRejectsUnsafeRelativePaths()
await checkUnknownArgFailFastSmoke()
await checkInstallSkillSmoke()

if (process.exitCode) {
  process.exit(process.exitCode)
}

console.log("[check] repo-demo-recorder skill checks passed")
