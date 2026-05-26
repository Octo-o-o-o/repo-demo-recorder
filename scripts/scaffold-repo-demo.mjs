#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULTS = {
  root: ".",
  name: "demo-flow",
  language: "zh-CN",
  subtitles: "open",
  flows: "core",
  out: "docs/recordings",
  baseUrl: "http://127.0.0.1:3210",
  audience: "qa-proof",
  polish: "formal-delivery",
  surface: "auto",
  force: false
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/scaffold-repo-demo.mjs [options]

Options:
  --root <dir>           Target repository root (default: .)
  --name <name>          Demo/scenario name (default: demo-flow)
  --language <locale>    zh-CN or en-US (default: zh-CN)
  --subtitles <mode>     none | open | sidecar | both (default: open)
  --flows <list>         Comma-separated flows, e.g. core,mobile,add-data
  --baseUrl <url>        Local app URL (default: http://127.0.0.1:3210)
  --audience <kind>      customer | internal-review | qa-proof | training | release-pr
  --polish <level>       quick-proof | formal-delivery | customer-ready
  --surface <surface>    auto | desktop | mobile | tablet | multi (default: auto)
  --out <dir>            Output docs dir (default: docs/recordings)
  --force                Overwrite generated files
`)
    process.exit(0)
  }
  const args = { ...DEFAULTS }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === "--force") {
      args.force = true
      continue
    }

    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }

    args[key] = next
    index += 1
  }

  args.name = slugify(args.name)
  args.flows = String(args.flows)
    .split(",")
    .map((flow) => flow.trim())
    .filter(Boolean)

  if (args.flows.length === 0) {
    args.flows = ["core"]
  }

  const allowedSurfaces = new Set(["auto", "desktop", "mobile", "tablet", "multi"])
  if (!allowedSurfaces.has(args.surface)) {
    throw new Error(`--surface must be one of: ${Array.from(allowedSurfaces).join(", ")}`)
  }

  return args
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "demo-flow"
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeNew(filePath, content, force) {
  if (!force && (await exists(filePath))) {
    throw new Error(`文件已存在，若要覆盖请加 --force：${filePath}`)
  }

  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

function buildScenario(args) {
  const flowLabels = {
    core: "核心浏览路径",
    "add-data": "新增数据流程",
    "edit-data": "编辑数据流程",
    "delete-data": "删除或归档流程",
    review: "审核与反馈流程",
    export: "导出与分享流程",
    "empty-error-loading": "空状态、错误状态与加载态",
    mobile: "移动端关键路径"
  }
  const inferredSurface =
    args.surface === "auto"
      ? args.flows.length === 1 && args.flows[0] === "mobile"
        ? "mobile"
        : "desktop"
      : args.surface
  const primarySurface = inferredSurface === "multi" ? "desktop" : inferredSurface
  const surfacePresets = {
    desktop: {
      viewport: { width: 1440, height: 960 },
      videoSize: { width: 1440, height: 960 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1
    },
    mobile: {
      viewport: { width: 390, height: 844 },
      videoSize: { width: 1080, height: 1920 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    },
    tablet: {
      viewport: { width: 820, height: 1180 },
      videoSize: { width: 1080, height: 1440 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    }
  }
  const activeSurface = surfacePresets[primarySurface] || surfacePresets.desktop
  const isPortrait = activeSurface.videoSize.height > activeSurface.videoSize.width
  const isMobile = primarySurface === "mobile"

  return {
    name: args.name,
    title: `${flowLabels[args.flows[0]] || "项目演示"}录屏`,
    baseUrl: args.baseUrl,
    language: args.language,
    subtitles: args.subtitles,
    surface: inferredSurface,
    surfaces:
      inferredSurface === "multi"
        ? surfacePresets
        : { [primarySurface]: activeSurface },
    primarySurface,
    audience: args.audience,
    polish: args.polish,
    narrative: {
      angle: args.audience === "customer" ? "customer-value" : "proof",
      avoidVisibleTerms:
        args.audience === "customer"
          ? ["mock", "fixture", "renderer-only", "内部边界", "临时脚本", "dev warning"]
          : [],
      defaultCaptionPattern:
        args.audience === "customer" ? "客户价值 + 可控机制" : "操作目标 + 验收点"
    },
    narration: {
      enabled: false,
      engine: args.audience === "customer" ? "edge-tts" : "local-system",
      language: args.language,
      voice:
        args.audience === "customer"
          ? args.language === "en-US"
            ? "en-US-GuyNeural"
            : "zh-CN-YunyangNeural"
          : args.language === "en-US"
            ? "Samantha"
            : "Tingting",
      rate: args.language === "en-US" ? 165 : 180,
      mix: "replace",
      timing: "auto",
      padMode: "freeze",
      padBufferMs: 300,
      maxPaddingMs: 60000
    },
    style: "qa-proof",
    viewport: activeSurface.viewport,
    recording: {
      videoSize: activeSurface.videoSize,
      orientation: isPortrait ? "portrait" : "landscape"
    },
    device: {
      isMobile: activeSurface.isMobile,
      hasTouch: activeSurface.hasTouch,
      deviceScaleFactor: activeSurface.deviceScaleFactor,
      userAgent: activeSurface.userAgent || null
    },
    overlay: {
      animation: "safe-opacity",
      settleMs: 160,
      chapterBanner: args.audience === "customer",
      chapterPosition: "top-center",
      captionPosition: isPortrait ? "bottom-center" : "bottom-left"
    },
    cover: {
      enabled: args.polish !== "quick-proof",
      mode: args.polish === "quick-proof" ? "standard" : "with-candidates",
      width: isPortrait ? 1080 : 1280,
      height: isPortrait ? 1920 : 720,
      title: args.audience === "customer" ? "Product Demo" : `${flowLabels[args.flows[0]] || "项目演示"}`,
      subtitle:
        args.audience === "customer"
          ? isMobile
            ? "Mobile product walkthrough"
            : "Customer-ready product walkthrough"
          : "Verified product walkthrough",
      line:
        args.audience === "customer"
          ? isMobile
            ? "Portrait UI · Touch flow · Mobile captions"
            : "Home · Search · Automation"
          : "Scripted recording · Captions · Quality report",
      badge:
        args.audience === "customer"
          ? isMobile
            ? "MOBILE DEMO"
            : "CUSTOMER DEMO"
          : args.audience === "training"
            ? "TRAINING"
            : "VERIFIED DEMO",
      timestamp: "auto"
    },
    segmentation: {
      enabled: args.polish !== "quick-proof",
      reviewEachSegment: args.polish !== "quick-proof",
      mergeAfterPass: args.polish !== "quick-proof",
      rerecordOnFailure: args.polish === "customer-ready"
    },
    auth: {
      mode: "manual-or-dev-login",
      endpoint: null,
      payload: null,
      storageState: null
    },
    data: {
      strategy: args.flows.some((flow) => flow.includes("data")) ? "ui-write" : "readonly",
      backupCommand: "npm run db:backup",
      seedCommand: null,
      demoPrefix: "演示",
      cleanup: false
    },
    server: {
      command: "npm run dev",
      port: 3210,
      healthPath: "/login"
    },
    outputs: {
      dir: args.out,
      mp4: true,
      webm: true,
      report: true,
      finalScreenshot: true,
      sidecarSubtitles: ["sidecar", "both"].includes(args.subtitles),
      narratedMp4: false,
      narrationTranscript: false,
      mediaReport: false,
      coverImage: args.polish !== "quick-proof",
      coverCandidates: args.polish !== "quick-proof"
    },
    review: {
      writeFrameReview: args.polish !== "quick-proof",
      frameReviewDir: `${args.out}/${args.name}-frame-review`,
      sampleCueKinds: ["chapter", "caption"],
      sampleOffsetsMs: [-220, -80, 80, 220]
    },
    qualityGates: {
      maxOverflow: 0,
      allowPageErrors: false,
      allowedResponseErrors: [],
      requireApiSuccess: args.flows.some((flow) => flow.includes("data")),
      requireDbAssertions: args.flows.some((flow) => flow.includes("data")),
      media: {
        requireAudio: false,
        minDurationRatio: 0.98,
        minAudioMaxDb: -50,
        expectWidth: activeSurface.videoSize.width,
        expectHeight: activeSurface.videoSize.height
      }
    },
    flows: args.flows.map((flow) => ({
      id: flow,
      surface: flow === "mobile" ? "mobile" : primarySurface,
      route: "/",
      caption: {
        title: flowLabels[flow] || flow,
        body: "补充这一页的业务价值、核心操作和观看重点。",
        durationMs: 3200
      },
      steps: [
        { type: "goto", url: "/" },
        {
          type: "caption",
          title: flowLabels[flow] || flow,
          body: "替换为该流程的真实说明字幕。",
          durationMs: 3000
        },
        {
          type: "screenshot",
          name: `${flow}-checkpoint`
        }
      ],
      assertions: []
    }))
  }
}

function buildGuide(args, scenario, scenarioPath, scriptPath) {
  const videoSize = scenario.recording?.videoSize || scenario.viewport || { width: 1440, height: 960 }
  const coverSize = scenario.cover || { width: 1280, height: 720 }
  const isPortrait = Number(videoSize.height) > Number(videoSize.width)
  const surfaceText =
    scenario.primarySurface === "mobile"
      ? "手机端竖屏"
      : scenario.primarySurface === "tablet"
        ? "平板端"
        : "桌面端横屏"
  const coverRatioText = Number(coverSize.height) > Number(coverSize.width) ? "9:16 竖屏" : "16:9 横屏"
  const coverSubtitle =
    scenario.primarySurface === "mobile"
      ? "Mobile product walkthrough"
      : args.audience === "customer"
        ? "Customer-ready product walkthrough"
        : "Verified product walkthrough"

  return `# 录屏说明

## 基本信息

- 场景：\`${args.name}\`
- 场景文件：\`${scenarioPath}\`
- 脚本文件：\`${scriptPath}\`
- 字幕：\`${args.subtitles}\`
- 字幕语言：\`${args.language}\`
- 业务流程：\`${args.flows.join(", ")}\`
- 目标观众：\`${args.audience}\`
- 精修级别：\`${args.polish}\`
- 端类型：\`${surfaceText}\`
- 视频尺寸：\`${videoSize.width}x${videoSize.height}\`
- 封面尺寸：\`${coverSize.width}x${coverSize.height}\`

## 录制前

1. 确认本地服务依赖可用。
2. 如果场景会写入数据库，先运行场景中的 \`data.backupCommand\`。
3. 补齐场景 JSON 里的 route、selector、API 断言、DB 断言和字幕文案。
4. 避免真实客户数据、真实密码、token、邮箱验证码入镜。
5. 如果目标观众是客户，字幕和旁白先讲客户价值，再讲可控机制；不要把 mock、fixture、临时脚本、dev warning 等内部词放进画面。
6. 如果项目同时有桌面端和手机版，手机版单独录制竖屏版本；不要把桌面横屏视频直接裁成手机视频。

## 录制

\`\`\`bash
node ${scriptPath}
\`\`\`

## 增加 TTS 解说

\`\`\`bash
node <skill>/scripts/add-tts-narration.mjs --video ${args.out}/${args.name}.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-narrated.mp4 --language ${args.language} --engine edge-tts --pad-mode freeze --pad-buffer-ms 300
\`\`\`

> \`--pad-mode freeze\`（默认）会在某段 TTS 超过窗口长度时，自动在那段 cue 末尾插入冻结帧让配音读完，并把后续 cue 时间轴整体后移。生成的 narration-report 里有 \`timeline.totalPaddingMs\` 和每段的 \`paddingMs\` 可供查证。如果某段 padding 超过 \`--max-padding-ms\`（默认 60000）会 fail-fast，请缩短该段文案。
> \`--engine edge-tts\` 需要 \`uvx\` 和网络，会把解说文本发送到 Microsoft Edge online TTS。不能使用在线 TTS 时，可改为 \`--engine macos-say --voice Tingting\`。

## 生成封面

正式交付建议生成标准 ${coverRatioText} 封面，并先查看候选图：

\`\`\`bash
node <skill>/scripts/generate-video-cover.mjs --video ${args.out}/${args.name}-narrated.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-cover.png --title "${args.audience === "customer" ? "Product Demo" : "Verified Demo"}" --subtitle "${coverSubtitle}" --width ${coverSize.width} --height ${coverSize.height} --theme ${scenario.primarySurface === "mobile" ? "mobile" : args.audience === "training" ? "training" : args.audience === "customer" ? "customer" : "proof"} --candidates-dir ${args.out}/${args.name}-cover-candidates
\`\`\`

检查 \`${args.out}/${args.name}-cover-candidates/contact-sheet.png\` 后，如果自动选择的画面不够代表产品主线，使用 \`--timestamp 00:00:36\` 指定更合适的帧重新生成。

## 质量门禁

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --require-audio --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

如果使用默认 TTS 输出名，建议把 narration report 一并纳入时长校验：

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --require-audio --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

## 字幕原则

- 说明这一页能解决什么业务问题，不解释脚本细节。
- 每条字幕控制在 1-2 行，避开表单输入区和主按钮。
- 高亮只用于引导视线，点击/输入前必须清除。
${isPortrait ? "- 竖屏手机视频的字幕使用底部安全区，但必须避开底部导航、输入框和主 CTA。\n" : ""}

## 画面专业度

- Overlay 固定在最终位置，只做短时透明度变化。
- 不使用 \`translateY/translateX/scale/clip-path\` 作为出现或收起动画。
- 字幕时间从 overlay 稳定后开始记录；收起后等待过渡结束再继续操作。
- 正式交付检查 \`${args.out}/${args.name}-frame-review/contact-sheet.png\`，确认字幕和章节横幅没有半截遮罩或遮挡关键控件。
- 检查 \`${args.out}/${args.name}-cover.png\`，确认产品名/演示主题清晰、真实 UI 可见、封面没有内部术语。
`
}

function buildRunner(scenarioRelativePath, scriptToRootRelative) {
  return `#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { chromium } from "playwright"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, ${JSON.stringify(scriptToRootRelative)})
const scenarioPath = path.resolve(projectRoot, ${JSON.stringify(scenarioRelativePath)})
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"))
const outputDir = scenario.outputs?.dir && path.isAbsolute(scenario.outputs.dir)
  ? scenario.outputs.dir
  : path.resolve(projectRoot, scenario.outputs?.dir || "docs/recordings")
await mkdir(outputDir, { recursive: true })

const report = {
  createdAt: new Date().toISOString(),
  baseUrl: scenario.baseUrl,
  scenario: scenario.name,
  surface: scenario.surface || scenario.primarySurface || "desktop",
  language: scenario.language,
  subtitles: scenario.subtitles,
  demoData: {},
  captions: [],
  steps: [],
  consoleMessages: [],
  pageErrors: [],
  responseErrors: []
}
const wantsOpenCaptions = ["open", "both"].includes(scenario.subtitles)
const wantsAnyCaptions = scenario.subtitles !== "none"
const overlaySettleMs = Number(scenario.overlay?.settleMs ?? 160)
let startedServer = null
const activeSurface =
  scenario.surfaces?.[scenario.primarySurface || scenario.surface] ||
  scenario.surfaces?.[scenario.surface] ||
  {
    viewport: scenario.viewport || { width: 1440, height: 960 },
    videoSize: scenario.recording?.videoSize || scenario.viewport || { width: 1440, height: 960 }
  }
const contextViewport = activeSurface.viewport || scenario.viewport || { width: 1440, height: 960 }
const videoSize = activeSurface.videoSize || scenario.recording?.videoSize || contextViewport

const RECORDER_STYLES = \`
  [data-recorder-chapter] {
    position: fixed;
    left: 50%;
    top: 28px;
    transform: translateX(-50%);
    z-index: 2147483647;
    width: min(720px, calc(100vw - 112px));
    padding: 15px 18px 16px 22px;
    border-left: 5px solid #0f62fe;
    border-radius: 8px;
    background: rgba(17, 24, 39, 0.94);
    color: #f8fafc;
    font: 500 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 24px 70px rgba(15, 23, 42, 0.28);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    contain: layout paint;
    backface-visibility: hidden;
    will-change: opacity;
    transition: opacity 90ms ease-out, visibility 0s linear 90ms;
  }
  [data-recorder-chapter][data-visible="true"] {
    opacity: 1;
    visibility: visible;
    transition: opacity 90ms ease-out;
  }
  [data-recorder-chapter] strong {
    display: block;
    margin-bottom: 4px;
    color: #fff;
    font-size: 24px;
    line-height: 1.2;
    letter-spacing: 0;
  }
  [data-recorder-caption] {
    position: fixed;
    left: 28px;
    bottom: 28px;
    z-index: 2147483646;
    max-width: min(560px, calc(100vw - 56px));
    padding: 14px 18px;
    border-left: 3px solid #0f62fe;
    background: rgba(24, 31, 44, 0.9);
    color: #f8fafc;
    font: 500 15px/1.65 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 16px 44px rgba(15, 23, 42, 0.24);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    contain: layout paint;
    backface-visibility: hidden;
    will-change: opacity;
    transition: opacity 90ms ease-out, visibility 0s linear 90ms;
  }
  [data-recorder-caption][data-visible="true"] {
    opacity: 1;
    visibility: visible;
    transition: opacity 90ms ease-out;
  }
  [data-recorder-caption] strong {
    display: block;
    margin-bottom: 2px;
    color: #78a9ff;
    font-size: 12px;
    line-height: 1.4;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  [data-recorder-highlight] {
    position: fixed;
    z-index: 2147483645;
    border: 2px solid #0f62fe;
    background: rgba(15, 98, 254, 0.11);
    box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.03);
    pointer-events: none;
    transition: opacity 120ms ease;
  }
  @media (max-width: 640px) {
    [data-recorder-chapter] {
      left: 14px;
      right: 14px;
      top: max(14px, env(safe-area-inset-top));
      transform: none;
      width: auto;
      padding: 12px 14px 13px 17px;
      border-left-width: 4px;
      border-radius: 8px;
    }
    [data-recorder-chapter] strong {
      font-size: 18px;
      line-height: 1.18;
    }
    [data-recorder-caption] {
      left: 14px;
      right: 14px;
      bottom: max(16px, env(safe-area-inset-bottom));
      max-width: none;
      padding: 11px 13px 12px;
      border-left: 0;
      border-top: 3px solid #0f62fe;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
    }
    [data-recorder-caption] strong {
      font-size: 11px;
      letter-spacing: 0.04em;
    }
  }
\`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: contextViewport,
  recordVideo: { dir: outputDir, size: videoSize },
  locale: scenario.language === "en-US" ? "en-US" : "zh-CN",
  timezoneId: "Asia/Shanghai",
  isMobile: Boolean(activeSurface.isMobile ?? scenario.device?.isMobile),
  hasTouch: Boolean(activeSurface.hasTouch ?? scenario.device?.hasTouch),
  deviceScaleFactor: Number(activeSurface.deviceScaleFactor ?? scenario.device?.deviceScaleFactor ?? 1),
  userAgent: activeSurface.userAgent || scenario.device?.userAgent || undefined,
  storageState: scenario.auth?.storageState || undefined
})

// 每个新文档加载后自动重装 overlay（避免 navigation 清空 window.__recorder）
await context.addInitScript((styles) => {
  if (window.__recorderInstalled) return
  window.__recorderInstalled = true

  const ensureStyle = () => {
    if (document.getElementById("__recorder-styles")) return
    const head = document.head || document.documentElement
    if (!head) return
    const style = document.createElement("style")
    style.id = "__recorder-styles"
    style.textContent = styles
    head.appendChild(style)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureStyle, { once: true })
  } else {
    ensureStyle()
  }

  window.__recorder = {
    clearHighlight() {
      document.querySelectorAll("[data-recorder-highlight]").forEach((node) => node.remove())
    },
    clearCaption() {
      document.querySelectorAll("[data-recorder-caption]").forEach((node) => {
        node.dataset.visible = "false"
        window.setTimeout(() => node.remove(), 120)
      })
    },
    clearChapter() {
      document.querySelectorAll("[data-recorder-chapter]").forEach((node) => {
        node.dataset.visible = "false"
        window.setTimeout(() => node.remove(), 120)
      })
    },
    showChapter(title, body) {
      ensureStyle()
      this.clearChapter()
      const node = document.createElement("div")
      node.setAttribute("data-recorder-chapter", "true")
      node.dataset.visible = "false"
      const strong = document.createElement("strong")
      strong.textContent = title || ""
      const span = document.createElement("span")
      span.textContent = body || ""
      if (strong.textContent) node.appendChild(strong)
      if (span.textContent) node.appendChild(span)
      if (node.childNodes.length === 0) return
      document.body.appendChild(node)
      void node.offsetHeight
      node.dataset.visible = "true"
    },
    showCaption(title, body) {
      ensureStyle()
      this.clearCaption()
      const node = document.createElement("div")
      node.setAttribute("data-recorder-caption", "true")
      node.dataset.visible = "false"
      const strong = document.createElement("strong")
      strong.textContent = title || ""
      const span = document.createElement("span")
      span.textContent = body || ""
      if (strong.textContent) node.appendChild(strong)
      if (span.textContent) node.appendChild(span)
      if (node.childNodes.length === 0) return
      document.body.appendChild(node)
      void node.offsetHeight
      node.dataset.visible = "true"
    },
    showHighlight(rect) {
      ensureStyle()
      this.clearHighlight()
      const node = document.createElement("div")
      node.setAttribute("data-recorder-highlight", "true")
      node.style.left = Math.max(0, rect.left - 4) + "px"
      node.style.top = Math.max(0, rect.top - 4) + "px"
      node.style.width = (rect.width + 8) + "px"
      node.style.height = (rect.height + 8) + "px"
      document.body.appendChild(node)
    }
  }
}, RECORDER_STYLES)

const page = await context.newPage()
const videoT0 = performance.now()
const elapsed = () => Math.max(0, Math.round(performance.now() - videoT0))

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    report.consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    })
  }
})

page.on("pageerror", (error) => {
  report.pageErrors.push(String(error?.stack || error?.message || error))
})

page.on("response", async (response) => {
  const status = response.status()
  if (status >= 400) {
    report.responseErrors.push({
      status,
      url: response.url(),
      method: response.request().method()
    })
  }
})

async function clearHighlight() {
  await page.evaluate(() => window.__recorder?.clearHighlight?.()).catch(() => {})
  await page.waitForTimeout(80)
}

async function chapter(title, body, durationMs = 1250) {
  if (wantsOpenCaptions && scenario.overlay?.chapterBanner) {
    await page
      .evaluate(
        ({ title: chapterTitle, body: chapterBody }) =>
          window.__recorder?.showChapter?.(chapterTitle, chapterBody),
        { title, body }
      )
      .catch(() => {})
    await waitForOverlaySettled()
  }
  const startMs = elapsed()
  await page.waitForTimeout(durationMs)
  const endMs = elapsed()
  if (wantsOpenCaptions && scenario.overlay?.chapterBanner) {
    await page.evaluate(() => window.__recorder?.clearChapter?.()).catch(() => {})
    await waitForOverlaySettled()
  }
  if (wantsAnyCaptions) {
    report.captions.push({
      title,
      body,
      kind: "chapter",
      durationMs: endMs - startMs,
      startMs,
      endMs,
      at: new Date().toISOString()
    })
  }
}

async function caption(title, body, durationMs = 2800) {
  if (wantsOpenCaptions) {
    await page
      .evaluate(
        ({ title: captionTitle, body: captionBody }) =>
          window.__recorder?.showCaption?.(captionTitle, captionBody),
        { title, body }
      )
      .catch(() => {})
    await waitForOverlaySettled()
  }
  const startMs = elapsed()
  await page.waitForTimeout(durationMs)
  const endMs = elapsed()
  if (wantsOpenCaptions) {
    await page.evaluate(() => window.__recorder?.clearCaption?.()).catch(() => {})
    await waitForOverlaySettled()
  }
  if (wantsAnyCaptions) {
    report.captions.push({
      title,
      body,
      durationMs: endMs - startMs,
      startMs,
      endMs,
      at: new Date().toISOString()
    })
  }
}

async function isServing(url) {
  try {
    const response = await fetch(url, { method: "GET" })
    return response.status < 500
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 120_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServing(url)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(\`Timed out waiting for dev server: \${url}\`)
}

async function ensureServer() {
  const healthUrl = new URL(scenario.server?.healthPath || "/", scenario.baseUrl).toString()
  if (await isServing(healthUrl)) return
  if (!scenario.server?.command) {
    throw new Error(\`No server is listening at \${healthUrl}, and scenario.server.command is empty\`)
  }
  const child = spawn(scenario.server.command, {
    cwd: projectRoot,
    shell: true,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  startedServer = child
  child.stdout.on("data", (chunk) => process.stdout.write(\`[demo-server] \${chunk}\`))
  child.stderr.on("data", (chunk) => process.stderr.write(\`[demo-server] \${chunk}\`))
  await waitForServer(healthUrl)
}

async function stopServer() {
  if (!startedServer) return
  startedServer.kill("SIGTERM")
  await new Promise((resolve) => setTimeout(resolve, 650))
  if (!startedServer.killed) startedServer.kill("SIGKILL")
  startedServer = null
}

async function waitForNextPaint() {
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })
    )
    .catch(() => {})
}

async function waitForOverlaySettled() {
  await waitForNextPaint()
  await page.waitForTimeout(overlaySettleMs)
}

function formatVttTime(ms) {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = Math.floor(ms % 1000)
  return \`\${String(hours).padStart(2, "0")}:\${String(minutes).padStart(2, "0")}:\${String(seconds).padStart(2, "0")}.\${String(millis).padStart(3, "0")}\`
}

function buildVtt(captions) {
  const cues = captions.map((item, index) => {
    const text = [item.title, item.body].filter(Boolean).join("\\n")
    return \`\${index + 1}\\n\${formatVttTime(item.startMs || 0)} --> \${formatVttTime(item.endMs || 0)}\\n\${text}\`
  })
  return \`WEBVTT\\n\\n\${cues.join("\\n\\n")}\\n\`
}

async function highlight(selector, holdMs = 300) {
  const locator = page.locator(selector).first()
  await locator.waitFor({ state: "visible", timeout: 10_000 })
  const box = await locator.boundingBox()
  if (box) {
    await page.evaluate((rect) => window.__recorder?.showHighlight?.(rect), box)
    await page.waitForTimeout(holdMs)
  }
  return locator
}

async function measureStep(label) {
  const metrics = await page.evaluate(() => ({
    url: window.location.pathname + window.location.search,
    highlightVisible: document.querySelectorAll("[data-recorder-highlight]").length > 0,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  }))
  report.steps.push({ label, ...metrics, atMs: elapsed() })
}

async function waitForApi(waitForApi, action) {
  if (!waitForApi) {
    await action()
    return null
  }

  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    const matchesMethod = !waitForApi.method || request.method() === waitForApi.method
    const matchesPath = !waitForApi.path || response.url().includes(waitForApi.path)
    const matchesOk = waitForApi.ok == null || response.ok() === Boolean(waitForApi.ok)
    return matchesMethod && matchesPath && matchesOk
  }, { timeout: waitForApi.timeoutMs || 20_000 })

  await action()
  return responsePromise
}

async function runStep(flow, step, index) {
  const label = step.label || \`\${flow.id}-\${index + 1}-\${step.type}\`

  if (step.caption) {
    await caption(
      step.caption.title || flow.caption?.title || label,
      step.caption.body || step.caption,
      step.caption.durationMs || 2200
    )
  }

  if (step.type === "goto") {
    await clearHighlight()
    await page.goto(new URL(step.url || step.route || flow.route || "/", scenario.baseUrl).toString(), {
      waitUntil: "networkidle"
    })
  } else if (step.type === "chapter") {
    await chapter(step.title || flow.caption?.title || label, step.body || flow.caption?.body || "", step.durationMs || 1250)
  } else if (step.type === "caption") {
    await caption(step.title || flow.caption?.title || label, step.body || flow.caption?.body || "", step.durationMs || 3000)
  } else if (step.type === "click") {
    const locator = await highlight(step.selector, step.highlightMs || 300)
    await clearHighlight()
    await waitForApi(step.waitForApi, async () => {
      await locator.click({ delay: step.delayMs || 40 })
    })
    if (step.waitForUrl) {
      await page.waitForURL(new RegExp(step.waitForUrl), { timeout: step.timeoutMs || 20_000 })
    }
  } else if (step.type === "fill") {
    const locator = await highlight(step.selector, step.highlightMs || 300)
    await clearHighlight()
    await locator.fill(step.value || "")
  } else if (step.type === "select") {
    const locator = await highlight(step.selector, step.highlightMs || 300)
    await clearHighlight()
    if (step.optionLabel) {
      await locator.selectOption({ label: step.optionLabel })
    } else {
      await locator.selectOption(step.value)
    }
  } else if (step.type === "scroll") {
    await clearHighlight()
    await page.mouse.wheel(step.x || 0, step.y || 600)
    await page.waitForTimeout(step.durationMs || 800)
  } else if (step.type === "wait") {
    await clearHighlight()
    if (step.selector) {
      await page.locator(step.selector).first().waitFor({ state: step.state || "visible", timeout: step.timeoutMs || 10_000 })
    } else if (step.url) {
      await page.waitForURL(new RegExp(step.url), { timeout: step.timeoutMs || 10_000 })
    } else {
      await page.waitForTimeout(step.durationMs || 1000)
    }
  } else if (step.type === "screenshot") {
    await clearHighlight()
    await page.screenshot({ path: path.join(outputDir, \`\${scenario.name}-\${step.name || label}.png\`), fullPage: true })
  } else if (step.type === "assert") {
    await clearHighlight()
    if (step.text) {
      await page.getByText(step.text, { exact: Boolean(step.exact) }).first().waitFor({ timeout: step.timeoutMs || 10_000 })
    }
  } else {
    throw new Error(\`未知 step 类型：\${step.type}\`)
  }

  await clearHighlight()
  await measureStep(label)
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(\`ffmpeg failed (status=\${code})\\n\${stderr.slice(-2000)}\`))
    })
  })
}

async function convertToMp4(webmPath, mp4Path) {
  await runFfmpeg([
    "-y",
    "-i",
    webmPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "20",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    mp4Path
  ])
}

try {
  await ensureServer()
  await page.goto(scenario.baseUrl, { waitUntil: "domcontentloaded" })

  for (const flow of scenario.flows || []) {
    await page.goto(new URL(flow.route || "/", scenario.baseUrl).toString(), { waitUntil: "networkidle" })
    if (scenario.overlay?.chapterBanner) {
      await chapter(flow.caption?.title || flow.id, flow.caption?.body || "", flow.chapterDurationMs || 1250)
    } else {
      await caption(flow.caption?.title || flow.id, flow.caption?.body || "", flow.caption?.durationMs || 3000)
    }

    for (const [index, step] of (flow.steps || []).entries()) {
      await runStep(flow, step, index)
    }

    for (const assertion of flow.assertions || []) {
      if (assertion.type === "text") {
        await page.getByText(assertion.value, { exact: Boolean(assertion.exact) }).first().waitFor({ timeout: 10_000 })
      }
    }
  }

  await clearHighlight()
  await page.screenshot({ path: path.join(outputDir, \`\${scenario.name}-final.png\`), fullPage: true })
} finally {
  const video = page.video()
  await context.close()
  let webmPath = null
  if (video) {
    webmPath = await video.path().catch(() => null)
  }
  await browser.close()

  report.webm = webmPath
  if (webmPath && scenario.outputs?.mp4 !== false) {
    const mp4Path = path.join(outputDir, \`\${scenario.name}.mp4\`)
    try {
      await convertToMp4(webmPath, mp4Path)
      report.mp4 = mp4Path
      report.video = mp4Path
    } catch (error) {
      console.warn(\`[recorder] mp4 转码失败，保留 webm：\${error.message}\`)
      report.video = webmPath
    }
  } else {
    report.video = webmPath
  }

  if (scenario.outputs?.sidecarSubtitles && report.captions.length > 0) {
    await writeFile(path.join(outputDir, \`\${scenario.name}.vtt\`), buildVtt(report.captions))
  }
  await writeFile(path.join(outputDir, \`\${scenario.name}-report.json\`), JSON.stringify(report, null, 2))
  console.log(\`[recorder] 已生成 report：\${path.join(outputDir, scenario.name + "-report.json")}\`)
  if (report.mp4) console.log(\`[recorder] 已生成 MP4：\${report.mp4}\`)
  if (report.webm) console.log(\`[recorder] 原始 WebM：\${report.webm}\`)
  await stopServer()
}
`
}

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root)
const outputDir = path.resolve(root, args.out)
const scriptDir = path.resolve(root, "scripts/recordings")
const scenarioPath = path.join(outputDir, `${args.name}.scenario.json`)
const scriptPath = path.join(scriptDir, `${args.name}.mjs`)
const guidePath = path.join(outputDir, "RECORDING_GUIDE.md")
const scenarioRelativePath = path.relative(root, scenarioPath)
const scriptRelativePath = path.relative(root, scriptPath)
const guideRelativePath = path.relative(root, guidePath)
const scriptToRootRelative = path.relative(path.dirname(scriptPath), root) || "."
const scenario = buildScenario(args)

await writeNew(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, args.force)
await writeNew(scriptPath, buildRunner(scenarioRelativePath, scriptToRootRelative), args.force)

const guideExists = await exists(guidePath)
let guideAction = "skipped"
if (!guideExists) {
  await writeFile(guidePath, buildGuide(args, scenario, scenarioRelativePath, scriptRelativePath))
  guideAction = "created"
} else if (args.force) {
  await writeFile(guidePath, buildGuide(args, scenario, scenarioRelativePath, scriptRelativePath))
  guideAction = "overwritten"
}

console.log(`已生成录屏场景：${scenarioRelativePath}`)
console.log(`已生成录屏脚本：${scriptRelativePath}`)
console.log(`录屏指南 (${guideAction})：${guideRelativePath}`)
