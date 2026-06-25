#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULTS = {
  root: ".",
  name: "demo-flow",
  language: "zh-CN",
  subtitles: "open",
  flows: "core",
  out: "docs/recordings",
  baseUrl: null,
  audience: "qa-proof",
  polish: "formal-delivery",
  surface: "auto",
  dataMode: "mock",
  ttsProvider: "auto",
  allowProduction: false,
  force: false
}

const TTS_PROVIDERS = ["auto", "macos-say", "local-system", "edge-tts", "doubao-tts-v3"]

// 检测项目类型与默认运行参数。返回 { kind, packageManager, devCommand, port, baseUrl, warnings }
async function detectProject(rootDir) {
  const result = {
    kind: "unknown",
    packageManager: "npm",
    devCommand: null,
    port: null,
    baseUrl: null,
    healthPath: "/",
    warnings: []
  }

  // 原生项目识别（不能跑 Playwright）
  const nativeMarkers = [
    { name: "iOS / macOS (Xcode)", pattern: /\.(xcodeproj|xcworkspace)$/, kind: "ios" },
    { name: "iOS / macOS (XcodeGen project.yml)", file: "project.yml", kind: "ios" }
  ]
  try {
    const entries = readdirSync(rootDir)
    for (const marker of nativeMarkers) {
      if (marker.pattern && entries.some((entry) => marker.pattern.test(entry))) {
        result.kind = marker.kind
        result.warnings.push(
          `检测到原生 App 项目 (${marker.name})：generated runner 不能驱动原生 UI，请改走 SKILL.md 中的"外部录屏接入"工作流，并忽略 server/auth/healthPath 字段。`
        )
        return result
      }
      if (marker.file && entries.includes(marker.file)) {
        result.kind = marker.kind
        result.warnings.push(
          `检测到原生 App 项目 (${marker.name})：generated runner 不能驱动原生 UI，请改走 SKILL.md 中的"外部录屏接入"工作流，并忽略 server/auth/healthPath 字段。`
        )
        return result
      }
    }
    if (entries.some((entry) => /^build\.gradle/.test(entry))) {
      const hasAndroidManifest = existsSync(path.join(rootDir, "app/src/main/AndroidManifest.xml"))
      if (hasAndroidManifest) {
        result.kind = "android"
        result.warnings.push(
          "检测到 Android 原生 App 项目：generated runner 不能驱动原生 UI，请改走 SKILL.md 中的\"外部录屏接入\"工作流。"
        )
        return result
      }
    }
  } catch {
    // ignore
  }

  // package manager 检测
  if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) result.packageManager = "pnpm"
  else if (existsSync(path.join(rootDir, "yarn.lock"))) result.packageManager = "yarn"
  else if (existsSync(path.join(rootDir, "bun.lockb"))) result.packageManager = "bun"
  else if (existsSync(path.join(rootDir, "package-lock.json"))) result.packageManager = "npm"

  // package.json 解析
  const pkgPath = path.join(rootDir, "package.json")
  let pkg = null
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8"))
    } catch {
      // ignore
    }
  }

  // Tauri 检测：tauri.conf.json 优先（包含 devUrl 和 beforeDevCommand）
  const tauriConfPaths = [
    path.join(rootDir, "src-tauri/tauri.conf.json"),
    path.join(rootDir, "tauri.conf.json")
  ]
  for (const tauriConfPath of tauriConfPaths) {
    if (existsSync(tauriConfPath)) {
      try {
        const tauriConf = JSON.parse(await readFile(tauriConfPath, "utf8"))
        const devUrl = tauriConf?.build?.devUrl
        const beforeDev = tauriConf?.build?.beforeDevCommand
        if (devUrl) {
          result.kind = "tauri"
          result.baseUrl = devUrl
          try {
            result.port = Number(new URL(devUrl).port) || null
          } catch {
            // ignore
          }
          if (beforeDev) {
            result.devCommand = beforeDev
          } else if (pkg?.scripts?.dev) {
            result.devCommand = `${result.packageManager} dev`
          }
          result.warnings.push(
            "检测到 Tauri 项目：录屏会在浏览器中跑 Vite/前端构建，调用 Tauri invoke API 的代码会失败并产生 pageError。建议为 demo 加 `if (window.__TAURI__) {...} else {/* mock */}` 兜底，或为 console error/pageError 配置 allowlist。"
          )
          return result
        }
      } catch {
        // ignore
      }
    }
  }

  if (pkg) {
    // Vite 检测
    const isVite =
      Boolean(pkg.devDependencies?.vite || pkg.dependencies?.vite) ||
      existsSync(path.join(rootDir, "vite.config.ts")) ||
      existsSync(path.join(rootDir, "vite.config.js")) ||
      existsSync(path.join(rootDir, "vite.config.mjs"))
    // Next 检测
    const isNext =
      Boolean(pkg.devDependencies?.next || pkg.dependencies?.next) ||
      existsSync(path.join(rootDir, "next.config.js")) ||
      existsSync(path.join(rootDir, "next.config.mjs")) ||
      existsSync(path.join(rootDir, "next.config.ts"))

    if (isVite) {
      result.kind = result.kind === "unknown" ? "vite" : result.kind
      result.port = result.port || 5173
      // 检查 vite.config 中是否覆盖了端口
      for (const viteConfig of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
        const configPath = path.join(rootDir, viteConfig)
        if (existsSync(configPath)) {
          try {
            const text = await readFile(configPath, "utf8")
            const portMatch = text.match(/port:\s*(\d+)/)
            if (portMatch) result.port = Number(portMatch[1])
          } catch {
            // ignore
          }
          break
        }
      }
    } else if (isNext) {
      result.kind = "next"
      result.port = 3000
    } else if (pkg.scripts?.dev || pkg.scripts?.start) {
      result.kind = "node"
      result.port = 3000
    }

    // npm 必须 `npm run <script>`，其余包管理器（pnpm/yarn/bun）允许 `<pm> <script>` 简写。
    // 历史上这里输出过 "npm dev" 这种无效命令，runner 会立刻报 "Unknown command: dev"。
    const runPrefix =
      result.packageManager === "npm" ? "npm run" : result.packageManager
    if (pkg.scripts?.dev) {
      result.devCommand = `${runPrefix} dev`
    } else if (pkg.scripts?.start) {
      result.devCommand = `${runPrefix} start`
    }

    // 如果 dev/start 脚本里显式带了 `-p PORT` 或 `--port PORT`，
    // 优先使用脚本里的端口，避免按框架默认端口去 fetch baseUrl。
    const scriptValue = pkg.scripts?.dev || pkg.scripts?.start || ""
    const explicitPort = scriptValue.match(/(?:^|\s)(?:-p|--port)[\s=](\d{2,5})\b/)
    if (explicitPort) {
      result.port = Number(explicitPort[1])
    }
  }

  if (result.port) {
    result.baseUrl = `http://localhost:${result.port}`
  }
  return result
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
  --base-url <url>       Local app URL (auto-detected from package.json/tauri.conf.json/vite.config when omitted)
  --audience <kind>      customer | internal-review | qa-proof | training | release-pr
  --polish <level>       quick-proof | formal-delivery | customer-ready
  --surface <surface>    auto | desktop | mobile | tablet | multi (default: auto)
  --data-mode <mode>     mock | staging | production (default: mock)
                         mock: local dev + seeded fixtures, safe to record/share.
                         staging: staging tenant + demo account; provide auth.storageState.
                         production: real customer data; REQUIRES --allow-production
                         and locks the scenario to readonly with a strict checklist.
  --tts-provider <name>   auto | macos-say | local-system | edge-tts | doubao-tts-v3
                         (default: auto; customer -> edge-tts, others -> macos-say)
  --allow-production     Confirm you have written authorization to record against
                         production data. Without this flag --data-mode production fails.
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
    if (token === "--allow-production") {
      args.allowProduction = true
      continue
    }

    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = toCamelCase(token.slice(2))
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }
    // fail-fast on typos：DEFAULTS 没有该字段就是拼错的参数。
    // 之前 --audiance customer 会被静默写入 args.audiance，然后按默认 audience=qa-proof 跑下去。
    if (!(key in DEFAULTS)) {
      throw new Error(
        `无法识别参数：${token}（拼写或大小写有误？）。详见 --help。\n` +
          `  当前支持：--root --name --language --subtitles --flows --base-url --audience ` +
          `--polish --surface --data-mode --tts-provider --allow-production --out --force`
      )
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
  const allowedAudiences = new Set([
    "customer",
    "internal-review",
    "qa-proof",
    "training",
    "release-pr"
  ])
  if (!allowedAudiences.has(args.audience)) {
    throw new Error(
      `--audience must be one of: ${Array.from(allowedAudiences).join(", ")} (received: ${args.audience})`
    )
  }
  const allowedPolish = new Set(["quick-proof", "formal-delivery", "customer-ready"])
  if (!allowedPolish.has(args.polish)) {
    throw new Error(
      `--polish must be one of: ${Array.from(allowedPolish).join(", ")} (received: ${args.polish})`
    )
  }
  const allowedLanguages = new Set(["zh-CN", "zh-TW", "en-US"])
  if (!allowedLanguages.has(args.language)) {
    throw new Error(
      `--language must be one of: ${Array.from(allowedLanguages).join(", ")} (received: ${args.language})`
    )
  }
  const allowedSubtitles = new Set(["none", "open", "sidecar", "both"])
  if (!allowedSubtitles.has(args.subtitles)) {
    throw new Error(
      `--subtitles must be one of: ${Array.from(allowedSubtitles).join(", ")} (received: ${args.subtitles})`
    )
  }
  // data-mode 是 MUST-ASK 项，强制三选一；production 必须配合 --allow-production，否则 fail-fast。
  // 这条 gate 比其它 enum 更严，因为录到生产数据是合规事故，不允许"默认通过"。
  const allowedDataModes = new Set(["mock", "staging", "production"])
  if (!allowedDataModes.has(args.dataMode)) {
    throw new Error(
      `--data-mode must be one of: ${Array.from(allowedDataModes).join(", ")} (received: ${args.dataMode})\n` +
        `  mock: local dev + seeded fixtures (default, safe).\n` +
        `  staging: staging tenant + demo account.\n` +
        `  production: real customer data; needs --allow-production.`
    )
  }
  if (args.dataMode === "production" && !args.allowProduction) {
    throw new Error(
      `--data-mode production requires --allow-production.\n` +
        `  Recording against real customer data is a compliance-sensitive action. Confirm:\n` +
        `    1) You have written authorization from the data owner (customer or DPO).\n` +
        `    2) The scenario will be readonly (no UI writes, no destructive clicks).\n` +
        `    3) No third-party customer data will be visible in the frame.\n` +
        `  When all three are true, re-run with --data-mode production --allow-production.\n` +
        `  Otherwise use --data-mode mock (local dev) or --data-mode staging (demo tenant).`
    )
  }
  if (args.dataMode !== "production" && args.allowProduction) {
    throw new Error(
      `--allow-production only makes sense with --data-mode production (got --data-mode ${args.dataMode}).`
    )
  }
  if (!TTS_PROVIDERS.includes(args.ttsProvider)) {
    throw new Error(
      `--tts-provider must be one of: ${TTS_PROVIDERS.join(", ")} (received: ${args.ttsProvider})`
    )
  }

  return args
}

function toCamelCase(value) {
  return value.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
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

function resolveTtsEngine(args) {
  if (args.ttsProvider !== "auto") return args.ttsProvider
  return args.audience === "customer" ? "edge-tts" : "macos-say"
}

function defaultNarrationVoice(language, engine) {
  if (engine === "doubao-tts-v3") return "zh_female_jitangmei_uranus_bigtts"
  if (engine === "edge-tts") {
    if (language === "en-US") return "en-US-GuyNeural"
    if (language === "zh-TW") return "zh-TW-YunJheNeural"
    return "zh-CN-YunyangNeural"
  }
  if (language === "zh-TW") return "Meijia"
  return language === "en-US" ? "Samantha" : "Tingting"
}

function buildNarrationConfig(args) {
  const engine = resolveTtsEngine(args)
  const narration = {
    // 正式交付及以上默认启用 TTS：与 SKILL.md "对正式 demo 默认生成 transcript/VTT，再用本地 TTS 合成" 对齐。
    enabled: args.polish !== "quick-proof",
    provider: args.ttsProvider,
    engine,
    language: args.language,
    voice: defaultNarrationVoice(args.language, engine),
    rate: args.language === "en-US" ? 165 : 180,
    mix: "replace",
    timing: "auto",
    padMode: "freeze",
    padBufferMs: 300,
    maxPaddingMs: 60000
  }

  if (engine === "edge-tts") {
    return {
      ...narration,
      edgeRate: "+0%",
      edgePitch: "+0Hz",
      edgeVolume: "+0%"
    }
  }

  if (engine === "doubao-tts-v3") {
    return {
      ...narration,
      doubaoEndpoint: "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
      doubaoResourceId: "seed-tts-2.0",
      doubaoModel: "seed-tts-2.0-expressive",
      doubaoSampleRate: 24000,
      doubaoBitRate: 128000,
      doubaoSpeechRate: 0,
      doubaoLoudnessRate: 20
    }
  }

  return narration
}

function buildScenario(args, detection = null) {
  const isZh = args.language !== "en-US"
  const flowLabels = isZh
    ? {
        core: "核心浏览路径",
        "add-data": "新增数据流程",
        "edit-data": "编辑数据流程",
        "delete-data": "删除或归档流程",
        review: "审核与反馈流程",
        export: "导出与分享流程",
        "empty-error-loading": "空状态、错误状态与加载态",
        mobile: "移动端关键路径"
      }
    : {
        core: "Core browsing",
        "add-data": "Add data",
        "edit-data": "Edit data",
        "delete-data": "Delete / archive",
        review: "Review & feedback",
        export: "Export & share",
        "empty-error-loading": "Empty / error / loading states",
        mobile: "Mobile critical path"
      }
  // 把 flowLabels 拼成一个简短的封面 line，比 hardcode "首页 · 搜索 · 自动化" 贴近用户实际 flows。
  // 取前 3 条 flow（足够装下 16:9 副标题宽度），中间用 " · " 分隔。
  const coverLineFromFlows = args.flows
    .map((flow) => flowLabels[flow] || flow)
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ")
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
  // 封面 line 优先用 args.flows 推断；如果用户的 flows 信息已经够具体（如 "add-data,edit-data"），
  // 直接用 flow labels 拼接；都对不上时再 fallback 到通用文案。
  // 历史上这里 hardcode "首页 · 搜索 · 自动化"，跟用户实际 flows 完全无关，封面误导客户演示。
  const coverFallbackLine = isZh ? "脚本录制 · 字幕 · 质量报告" : "Scripted recording · Captions · Quality report"
  const coverDefaults = isZh
    ? {
        customerDesktop: {
          title: "产品演示",
          subtitle: "面向客户的可发版走查",
          line: coverLineFromFlows || coverFallbackLine,
          badge: "客户演示"
        },
        customerMobile: {
          title: "移动端演示",
          subtitle: "移动端产品走查",
          line: coverLineFromFlows || "竖屏 UI · 触控流程 · 移动端字幕",
          badge: "移动端演示"
        },
        proof: {
          title: "项目演示",
          subtitle: "可验证的产品走查",
          line: coverLineFromFlows || coverFallbackLine,
          badge: "已验证演示"
        },
        training: {
          title: "操作培训",
          subtitle: "面向新成员的步骤讲解",
          line: coverLineFromFlows || "字段含义 · 操作顺序 · 验收点",
          badge: "培训 SOP"
        }
      }
    : {
        customerDesktop: {
          title: "Product Demo",
          subtitle: "Customer-ready product walkthrough",
          line: coverLineFromFlows || coverFallbackLine,
          badge: "CUSTOMER DEMO"
        },
        customerMobile: {
          title: "Mobile Product Demo",
          subtitle: "Mobile product walkthrough",
          line: coverLineFromFlows || "Portrait UI · Touch flow · Mobile captions",
          badge: "MOBILE DEMO"
        },
        proof: {
          title: "Verified Demo",
          subtitle: "Verified product walkthrough",
          line: coverLineFromFlows || coverFallbackLine,
          badge: "VERIFIED DEMO"
        },
        training: {
          title: "Training Walkthrough",
          subtitle: "Step-by-step training",
          line: coverLineFromFlows || "Fields · Steps · Acceptance",
          badge: "TRAINING"
        }
      }
  // audience → style 映射：之前一律 hardcode "qa-proof"，导致客户演示 scenario 在 style 字段里
  // 仍标注 qa-proof，与 audience 不一致。validate 不读 style，但用户/Screen Studio handoff 文档会读。
  const styleByAudience = {
    customer: "sales-demo",
    "internal-review": "qa-proof",
    "qa-proof": "qa-proof",
    training: "training",
    "release-pr": "release-pr"
  }
  const titleSuffix = isZh ? "录屏" : " recording"
  const titleFallback = isZh ? "项目演示" : "Product demo"

  return {
    name: args.name,
    title: `${flowLabels[args.flows[0]] || titleFallback}${titleSuffix}`,
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
    narration: buildNarrationConfig(args),
    style: styleByAudience[args.audience] || "qa-proof",
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
    cover: (() => {
      const profile =
        args.audience === "customer"
          ? isMobile
            ? coverDefaults.customerMobile
            : coverDefaults.customerDesktop
          : args.audience === "training"
            ? coverDefaults.training
            : coverDefaults.proof
      return {
        enabled: args.polish !== "quick-proof",
        mode: args.polish === "quick-proof" ? "standard" : "with-candidates",
        width: isPortrait ? 1080 : 1280,
        height: isPortrait ? 1920 : 720,
        title: profile.title,
        subtitle: profile.subtitle,
        line: profile.line,
        badge: profile.badge,
        timestamp: "auto"
      }
    })(),
    segmentation: {
      enabled: args.polish !== "quick-proof",
      reviewEachSegment: args.polish !== "quick-proof",
      mergeAfterPass: args.polish !== "quick-proof",
      rerecordOnFailure: args.polish === "customer-ready",
      transitionCover: {
        enabled: "auto",
        durationMs: 2400,
        fadeInMs: 180,
        fadeOutMs: 380,
        style: "subtle-subcover",
        label: isZh ? "接下来" : "Next"
      }
    },
    // preflight：在正式录制开始之前先跑一组步骤（不入镜、不入 report.captions/steps），
    // 用来把演示账号"预热"到一个适合录制的状态——例如关掉 first-run modal / 同意条款 /
    // 把 onboardingComplete 标成 true / 准备 seed 数据。
    //
    // 默认是空数组。常见模板见 RECORDING_GUIDE.md「演示账号预热」段落。
    // 支持的 step 类型仅限：goto / click / fill / wait / fetch。
    //
    // 示例：
    //   { "type": "fetch", "method": "PATCH", "url": "/api/user/profile",
    //     "body": { "onboardingComplete": true }, "expectOk": true }
    //   { "type": "click", "selector": "[data-testid=onboarding-skip]" }
    preflight: {
      steps: []
    },
    // auth 字段保留 storageState（runner 唯一会读的字段）；mode/endpoint/payload 留作人工 review 提示，
    // 仅在 dev-login 流程里手动填充。runner 不会自动调用 endpoint。
    auth: {
      mode: args.dataMode === "mock" ? "dev-login-or-storage-state" : "storage-state-required",
      // staging / production 模式必须用 storageState；mock 模式可以走 dev-login 或 storageState。
      // scaffold 默认值 null，用户必须在 RECORDING_GUIDE 指引下生成 storageState 并填进来。
      storageState: null,
      // 如果你的项目有 dev-login API，可补 endpoint/payload，并在 flow.steps 中加一段
      // { type: "goto", url: endpoint } 或自定义脚本去调用 fetch；runner 不会自动用它们。
      endpoint: null,
      payload: null
    },
    data: (() => {
      // data.mode 是 MUST-ASK 项，控制后续整条流水线的安全边界。
      // - mock: 本地 dev + seeded fixtures；可以任意 UI 写入、可以 cleanup。
      // - staging: staging 租户；写入只允许在演示账号下；不要 cleanup（多人共用）。
      // - production: 真实生产数据；强制 readonly；禁止任何 UI 写入，强制写入合规清单。
      const writeFlow = args.flows.some((flow) => flow.includes("data"))
      const isProd = args.dataMode === "production"
      return {
        mode: args.dataMode,
        // production 强制 readonly；其它模式按 flows 推断（含 data 类 flow → ui-write）。
        strategy: isProd ? "readonly" : writeFlow ? "ui-write" : "readonly",
        // production 禁止 cleanup（不能去碰真实数据）；mock 在写入型 flow 下默认 cleanup。
        cleanup: isProd ? false : writeFlow && args.dataMode === "mock",
        // backupCommand 仅在写入型录屏前提示用户运行；不会被 runner 自动调用。请改成项目实际的备份命令或设为 null。
        backupCommand: null,
        seedCommand: null,
        demoPrefix: isZh ? "演示" : "demo",
        // production 模式带一条强提醒，写入 scenario 让人审 scenario 时一眼看到。
        productionWarning: isProd
          ? (isZh
              ? "⚠️ 此 scenario 录制真实生产数据。开录前必须有数据拥有者书面授权，全程 readonly，画面不得出现其他客户数据。"
              : "⚠️ This scenario records against production data. Recording requires written authorization, must remain readonly, and must never expose other customers' data on screen.")
          : null
      }
    })(),
    server: {
      // 由 scaffold 自动检测 packageManager + dev script；检测不到时回退到 "npm run dev"。
      command: detection?.devCommand || "npm run dev",
      // healthPath 默认为根路径；改成项目真实的健康检查路径以减少误报。
      healthPath: detection?.healthPath || "/",
      // dev server 启动超时（毫秒）。大型 Next.js / Prisma / monorepo 首次启动可能要 2-3 分钟，
      // 当前 120000 在小型项目够用，超时不够请改大。runner 会读这个值。
      startupTimeoutMs: 120_000
    },
    outputs: {
      dir: args.out,
      mp4: true,
      webm: true,
      report: true,
      finalScreenshot: true,
      sidecarSubtitles: ["sidecar", "both"].includes(args.subtitles),
      narratedMp4: args.polish !== "quick-proof",
      narrationTranscript: args.polish !== "quick-proof",
      mediaReport: args.polish !== "quick-proof",
      reviewPage: args.polish !== "quick-proof",
      polishedMp4: args.polish === "customer-ready",
      screenStudioHandoff: false,
      coverImage: args.polish !== "quick-proof",
      coverCandidates: args.polish !== "quick-proof",
      coverIntro: args.polish !== "quick-proof",
      coverEmbedReport: args.polish !== "quick-proof",
      gapTrimReport: args.polish !== "quick-proof",
      assembledMp4: args.polish !== "quick-proof",
      assemblyReport: args.polish !== "quick-proof",
      segmentTransitionCovers: args.polish !== "quick-proof"
    },
    postProduction: {
      polishPreset: isPortrait ? "customer-mobile" : "customer-desktop",
      screenStudioTarget: isPortrait ? "mobile" : "desktop",
      useScreenStudioFor:
        args.polish === "customer-ready"
          ? ["manual zoom polish", "cursor smoothing", "device frame", "timeline edits"]
          : []
    },
    review: {
      writeFrameReview: args.polish !== "quick-proof",
      frameReviewDir: `${args.out}/${args.name}-frame-review`,
      sampleCueKinds: ["chapter", "caption"],
      sampleOffsetsMs: [-220, -80, 80, 220]
    },
    qualityGates: (() => {
      // 不同 dev server 会产生不同的"无害噪声"。Next.js dev 模式必然会有
      // /_next/static/* HMR 探针、source map 拉取失败、`/favicon.ico` 404、
      // 长连接 webpack-hmr 等，全部进 responseErrors 会让用户每次跑都 fail。
      const noisePresets = {
        next: [
          "/_next/static",
          "/_next/webpack-hmr",
          "/_next/data/development",
          "/__nextjs_original-stack-frames",
          "/__nextjs_source-map"
        ],
        vite: ["/@vite/client", "/@react-refresh", "/__vite_ping"],
        tauri: []
      }
      const detectedAllowed = noisePresets[detection?.kind] || []
      const writeFlow = args.flows.some((flow) => flow.includes("data"))
      return {
        maxOverflow: 0,
        // allowPageErrors / allowedResponseErrors / allowedConsoleErrors 由 validate-recording-report.mjs
        // 自动从 report.qualityGates 读取，无需再传 CLI flag。把已知噪声写在这里即可全流程沉淀。
        allowPageErrors: false,
        allowedResponseErrors: detectedAllowed,
        allowedConsoleErrors: [],
        // 写入型 flow 默认要求 API 成功断言；runner 会把每个 step.waitForApi 成功的
        // response 自动写到 report.apiAssertions[]，无需手动维护。
        requireApiSuccess: writeFlow,
        // DB 落库断言需要用户自己在 flow.steps 里加 type=="db" 节点（runner 不会自动
        // 连数据库）；默认不开，避免新手 scaffold 后必 fail。需要时再手动改为 true 并
        // 在 step 中提供 prismaQuery/sqlPath。
        requireDbAssertions: false,
        media: {
          // 启用 TTS 时默认要求音轨；纯 quick-proof 不强制。
          requireAudio: args.polish !== "quick-proof",
          // 启用 freeze padding 时输出可能比源略长，所以设 max 让超长被警告；可按需调高。
          minDurationRatio: 0.98,
          maxDurationRatio: null,
          minAudioMaxDb: -50,
          expectWidth: activeSurface.videoSize.width,
          expectHeight: activeSurface.videoSize.height
        }
      }
    })(),
    // flow.surface 与 primarySurface 强制一致。runner 不会按 flow.surface 切 viewport（一份录屏共享
    // 一个 browser context），如果让 mobile flow 写 surface=mobile 但实际在 desktop viewport 录制，
    // 会让用户错以为 runner 在录制中途切到手机端，反而埋下混合 surface 的坑。所以全部跟 primarySurface 走；
    // 真正想录 mobile，应该跑 `--surface mobile`（或 multi 再单独跑一遍）。
    // 默认 steps 给出一个"骨干模板"：goto → caption → scroll → caption → wait → caption → screenshot。
    // 历史上这里只 emit 3 步 (goto + caption + screenshot)，导致 raw 录屏只有 ~8 秒，跑完整流程后
    // 视频里大半时间都是 TTS freeze padding 在播放冻结帧，画面像卡住了一样。
    // 现在默认有 ~25-35 秒画面（多段滚动 + 多段字幕），让用户即使没填 click/fill 也能录到一段像样的
    // landing 浏览演示。需要更深入的操作（click selector / fill input / waitForApi / db assert），
    // 用户按 RECORDING_GUIDE.md 中的「step 模板」继续加即可。
    flows: args.flows.map((flow) => ({
      id: flow,
      surface: primarySurface,
      route: "/",
      caption: {
        title: flowLabels[flow] || flow,
        // body 默认留空，让 TTS 只读 title，避免 scaffold 默认占位文案被 TTS 朗读到客户视频里。
        // 用户在 scenario 里填上业务说明后，TTS 自动用 title + body 拼接。
        body: "",
        durationMs: 3200
      },
      steps: [
        { type: "goto", url: "/" },
        { type: "wait", durationMs: 1200 },
        {
          type: "caption",
          title: flowLabels[flow] || flow,
          // 同上：默认空字符串。runner 接收空 body 时只显示 title，TTS 也只读 title。
          body: "",
          durationMs: 3000
        },
        { type: "scroll", y: 800, durationMs: 1000 },
        {
          type: "caption",
          title: flowLabels[flow] || flow,
          body: "",
          durationMs: 3000
        },
        { type: "scroll", y: 800, durationMs: 1000 },
        {
          type: "caption",
          title: flowLabels[flow] || flow,
          body: "",
          durationMs: 3000
        },
        { type: "scroll", y: -1600, durationMs: 1200 },
        {
          type: "screenshot",
          name: `${flow}-checkpoint`
        }
      ],
      assertions: []
    }))
  }
}

// 把 data-mode 的录前准备清单做成可独立测试的 helper。每种 mode 的工作流差异很大：
// - mock：本地 dev 启动 + seed/fixture + dev-login，安全可发版。
// - staging：staging 租户登录、预备演示账号、storageState 落地，禁止 cleanup。
// - production：合规优先，必须 readonly，必须有书面授权，必须遮蔽他人数据。
function buildDataModeSection(mode, scenario, isEn) {
  if (mode === "production") {
    if (isEn) {
      return `## Data Source: Production ⚠️

This scenario records against **real production data**. Recording is allowed only when ALL of the following are true:

1. Written authorization from the data owner (customer / DPO) exists and is on file.
2. The flow stays **strictly readonly** — no clicks that submit forms, no \`type=fill\` followed by Save, no destructive actions. \`scenario.data.strategy\` is locked to \`readonly\` and \`scenario.data.cleanup=false\`.
3. The frame never exposes other tenants' data. Switch to the authorizing customer's tenant before recording; double-check the URL and tenant switcher are correct in the very first frame.
4. Real PII (emails, phone numbers, ID numbers, financial figures) that is not part of the authorized scope must be blurred or covered by overlays in post.
5. Auth uses an account explicitly approved for the demo — never a random employee account. Provide \`auth.storageState\` (recommended) or a dev-login token; do not type real passwords on camera.
6. The frame review contact sheet must be eyeballed before sharing — any accidental PII triggers a rerecord, not a redaction in post.

Do not record production data when any of the above is unclear. Re-scaffold with \`--data-mode staging\` (recommended) or \`--data-mode mock\` (safest) instead.`
    }
    return `## 数据来源：production（真实生产数据） ⚠️

本场景将录制**真实生产数据**。只有同时满足以下所有条件才允许开录：

1. 已取得数据拥有者（客户 / DPO）的**书面授权**并存档。
2. 全程**严格 readonly**——不点击任何提交按钮、不在表单后点保存、不做删除/归档/导出等破坏性动作。\`scenario.data.strategy\` 已锁定为 \`readonly\`，\`scenario.data.cleanup=false\`。
3. 画面绝不能出现其他租户的数据。开录前切换到授权客户的租户，第一帧就检查 URL、租户切换器是否正确。
4. 授权范围之外的真实 PII（邮箱、手机号、身份证号、金额）必须在后期用 overlay 遮蔽或马赛克。
5. 账号必须是**专门用于本次 demo 的授权账号**，不要用员工随手账号。提供 \`auth.storageState\`（推荐）或 dev-login token；不要在镜头前输入真实密码。
6. frame-review contact sheet 必须**人眼复查**后再分享。任何意外露出 PII 都应**重录**，不要靠后期遮挡。

只要有一条不确定，**不要录**。改用 \`--data-mode staging\`（推荐）或 \`--data-mode mock\`（最安全）重新 scaffold。`
  }
  if (mode === "staging") {
    if (isEn) {
      return `## Data Source: Staging

This scenario records against a **staging / pre-prod environment** with a dedicated demo account and demo tenant. Setup checklist:

1. \`scenario.baseUrl\` points to the staging host (e.g. \`https://staging.example.com\`). Update it if scaffold guessed wrong from \`localhost\`.
2. Provide \`scenario.auth.storageState\` — a JSON file produced by Playwright after logging in once:
   \`\`\`bash
   node -e "(async()=>{const{chromium}=await import('playwright');const b=await chromium.launch({headless:false});const c=await b.newContext();const p=await c.newPage();await p.goto('https://staging.example.com/login');console.log('Log in manually, then press Enter…');await new Promise(r=>process.stdin.once('data',r));await c.storageState({path:'./.auth/demo-staging.json'});await b.close()})()"
   \`\`\`
   Save the file outside the repo or under \`.auth/\` (gitignored). Then set \`scenario.auth.storageState\` to that absolute path.
3. The demo account should own a fully seeded tenant. Confirm dashboards, lists, and detail pages are populated before recording — empty states make for a weak demo.
4. \`scenario.data.cleanup=false\` because the staging tenant is shared; do not delete records after the recording.
5. Customer-facing recordings should not leak staging-only warnings, dev banners, or feature flags. Disable or hide them via the demo account's settings before recording.`
    }
    return `## 数据来源：staging（测试环境 + 演示账号）

本场景录制 **staging / pre-prod 环境**，使用专门的演示账号和演示租户。准备清单：

1. \`scenario.baseUrl\` 指向 staging 域名（例如 \`https://staging.example.com\`）。如果 scaffold 默认填了 \`localhost\`，请手动改。
2. 提供 \`scenario.auth.storageState\`——Playwright 登录一次后导出的 JSON 文件：
   \`\`\`bash
   node -e "(async()=>{const{chromium}=await import('playwright');const b=await chromium.launch({headless:false});const c=await b.newContext();const p=await c.newPage();await p.goto('https://staging.example.com/login');console.log('请手动登录，完成后按回车…');await new Promise(r=>process.stdin.once('data',r));await c.storageState({path:'./.auth/demo-staging.json'});await b.close()})()"
   \`\`\`
   文件保存到仓库外，或 \`.auth/\`（要加进 .gitignore）。然后把绝对路径写到 \`scenario.auth.storageState\`。
3. 演示账号应拥有已 seed 好的演示租户。开录前先确认 dashboard、列表、详情都有数据——空状态会让 demo 看起来很弱。
4. \`scenario.data.cleanup=false\`，因为 staging 租户是共享的，录完不要清数据。
5. 客户演示不应露出 staging-only 的 warning banner、dev 标记或未发布 feature flag。开录前在演示账号设置里关掉或隐藏。`
  }
  // mock（默认）
  if (isEn) {
    return `## Data Source: Mock (local dev + seeded fixtures)

This scenario runs **locally** with seeded fixtures. Setup checklist:

1. \`scenario.server.command\` (\`${scenario.server?.command || "npm run dev"}\`) starts the dev server. If the project also needs PostgreSQL / Redis / workers / external services, start them manually before \`node scripts/recordings/<name>.mjs\`.
2. Seed demo data **once** before recording. Common patterns:
   - Prisma: \`pnpm prisma db seed\` with a script that creates one demo user + a tenant full of representative records.
   - SQL / Drizzle: \`psql -f scripts/recordings/seed.sql\`.
   - In-memory: a route handler that wraps Next API routes for the duration of the demo (\`scripts/recordings/<name>-mock-server.mjs\`).
3. If the product requires login, generate \`scenario.auth.storageState\` so the runner enters the dashboard without a manual login flow. For projects with email OTP, hit \`/api/auth/send-code\` then \`/api/auth/verify-code\` directly from Node (the dev fallback usually logs the OTP to the server console). Save the resulting cookies into a JSON storage-state file and point \`auth.storageState\` at it.
4. **Pre-warm the demo account** — see "Demo account warm-up" below. Without this step a fresh account triggers first-run onboarding modals on every dashboard page and they stay on camera.
5. Mock recordings can safely use \`scenario.data.strategy=ui-write\` and \`cleanup=true\`. Add \`flow.steps\` for fill/click/waitForApi as needed.
6. Captions and narration can mention "sample / demo data" but should **not** mention \`mock\`, \`fixture\`, \`renderer-only\`, internal boundary names, or dev warnings (already enforced by \`narrative.avoidVisibleTerms\`).

### Demo account warm-up (\`scenario.preflight.steps\`)

A freshly created demo account usually has unmet first-run gates: onboarding dialogs, privacy consent banners, "welcome tour" overlays, empty-state placeholders. These will sit on top of every dashboard page during recording, making it look like the runner only captured the onboarding modal.

Use \`scenario.preflight.steps\` to dismiss them **before recording starts**. Preflight steps run with the same browser context (so cookies / localStorage / session apply) but do NOT enter the video, captions, or report timeline. Supported step types: \`goto / click / fill / wait / fetch\`.

The cleanest pattern is a single \`fetch\` directly to the project's profile API:

\`\`\`json
"preflight": {
  "steps": [
    {
      "type": "fetch",
      "method": "PATCH",
      "url": "/api/user/profile",
      "body": { "onboardingComplete": true },
      "expectOk": true
    }
  ]
}
\`\`\`

If the modal is purely client-side (no API), click through it instead:

\`\`\`json
"preflight": {
  "steps": [
    { "type": "goto", "url": "/dashboard" },
    { "type": "click", "selector": "[data-testid=onboarding-skip]" },
    { "type": "wait", "selector": "[data-testid=dashboard-ready]", "state": "visible" }
  ]
}
\`\`\`

If the gate is stored in \`localStorage\`, prefer building it into your \`auth.storageState\` JSON's \`origins[].localStorage\` array — that's faster than clicking through every recording.`
  }
  return `## 数据来源：mock（本地 dev + seeded 演示数据）

本场景在**本地**运行，演示数据由 seed 脚本 / fixture 提供。准备清单：

1. \`scenario.server.command\`（\`${scenario.server?.command || "npm run dev"}\`）会启动 dev server。如果项目还需要 PostgreSQL / Redis / worker / 外部服务，请在跑 \`node scripts/recordings/<name>.mjs\` 之前手动起好。
2. 录制前**一次性** seed 演示数据。常见做法：
   - Prisma：\`pnpm prisma db seed\`，seed 脚本里建一个演示用户 + 一个数据齐全的演示租户。
   - SQL / Drizzle：\`psql -f scripts/recordings/seed.sql\`。
   - 内存拦截：用一个 route handler 包住 Next API 路由（\`scripts/recordings/<name>-mock-server.mjs\`），仅在 demo 期间生效。
3. 如果产品需要登录，**生成 \`scenario.auth.storageState\`** 让 runner 直接以登录态进入 dashboard，不用录"手动登录"那一段。对邮箱 OTP 项目：直接从 Node 调 \`/api/auth/send-code\` + \`/api/auth/verify-code\`（dev fallback 通常会把 OTP 打到 server console 而不是真发邮件），把拿到的 cookie 保存成 storageState JSON，指给 \`auth.storageState\` 用。
4. **演示账号预热**——见下方「演示账号预热」段。**这一步常被漏掉**：新建的 demo 账号会在每个 dashboard 页面触发首登 onboarding modal / 隐私同意 / 新人引导，全程挡在镜头前，让人误以为 runner 没进 dashboard。
5. mock 模式可以放心 \`scenario.data.strategy=ui-write\` 和 \`cleanup=true\`。在 \`flow.steps\` 里按需加 fill/click/waitForApi。
6. 字幕和旁白可以提"示例数据 / 演示账号"，但**不要**说 \`mock\`、\`fixture\`、\`renderer-only\`、内部边界、dev warning 等内部词（\`narrative.avoidVisibleTerms\` 会强制校验）。

### 演示账号预热（\`scenario.preflight.steps\`）

新建的演示账号通常带着没完成的首登 gate：onboarding 弹窗、隐私同意 banner、"新人引导"浮层、空状态占位图。这些都会叠在每个 dashboard 页面上方，让录出来的视频看起来像是"runner 只录到了 onboarding 弹窗"。

用 \`scenario.preflight.steps\` 在**正式录制开始之前**关掉它们。preflight 跟正式录制共用同一个浏览器上下文（cookie / localStorage / session 都生效），但**不会进入视频、字幕、report 时间线**。支持的 step 类型：\`goto / click / fill / wait / fetch\`。

最干净的写法：直接 fetch 项目的 profile API：

\`\`\`json
"preflight": {
  "steps": [
    {
      "type": "fetch",
      "method": "PATCH",
      "url": "/api/user/profile",
      "body": { "onboardingComplete": true },
      "expectOk": true
    }
  ]
}
\`\`\`

如果 modal 是纯前端控制（没有 API），用 click 走完：

\`\`\`json
"preflight": {
  "steps": [
    { "type": "goto", "url": "/dashboard" },
    { "type": "click", "selector": "[data-testid=onboarding-skip]" },
    { "type": "wait", "selector": "[data-testid=dashboard-ready]", "state": "visible" }
  ]
}
\`\`\`

如果 gate 状态存在 \`localStorage\` 里，**优先**把对应的 entry 写进 \`auth.storageState\` 的 \`origins[].localStorage\` 数组——比每次录制都点一遍要快。`
}

function buildTtsProviderNote(scenario, isEn) {
  const narration = scenario.narration || {}
  const provider = narration.provider || "auto"
  const engine = narration.engine || "macos-say"
  const voice = narration.voice || "(default)"

  if (isEn) {
    const common =
      `> TTS provider: scaffold \`--tts-provider=${provider}\` resolved to \`engine=${engine}\`, \`voice=${voice}\`. ` +
      "To switch provider, re-run scaffold with `--tts-provider ...` or edit `scenario.narration.engine` / `voice`."
    if (engine === "doubao-tts-v3") {
      return `${common}\n> \`doubao-tts-v3\` uses Volcengine/Doubao streaming TTS. Keep API keys out of scenario files; set \`DOUBAO_TTS_API_KEY\` or \`VOLCENGINE_TTS_API_KEY\` in the shell before running add-tts.`
    }
    if (engine === "edge-tts") {
      return `${common}\n> \`edge-tts\` needs \`uvx\` and network access; it sends narration text to Microsoft Edge online TTS. For offline/private text, use \`--tts-provider macos-say\` or edit the scenario.`
    }
    return `${common}\n> \`${engine}\` uses local system speech on macOS. If the configured voice is missing, add-tts will try a locale-compatible fallback.`
  }

  const common =
    `> TTS provider：脚手架 \`--tts-provider=${provider}\` 解析为 \`engine=${engine}\`、\`voice=${voice}\`。` +
    "要换服务商，可重新 scaffold 加 `--tts-provider ...`，或直接改 `scenario.narration.engine` / `voice`。"
  if (engine === "doubao-tts-v3") {
    return `${common}\n> \`doubao-tts-v3\` 使用火山/豆包流式 TTS。不要把 API key 写进 scenario；运行 add-tts 前在 shell 里设置 \`DOUBAO_TTS_API_KEY\` 或 \`VOLCENGINE_TTS_API_KEY\`。`
  }
  if (engine === "edge-tts") {
    return `${common}\n> \`edge-tts\` 需要 \`uvx\` 和网络，会把解说文本发送到 Microsoft Edge online TTS。涉及敏感内容或不能使用在线 TTS 时，改用 \`--tts-provider macos-say\` 或修改 scenario。`
  }
  return `${common}\n> \`${engine}\` 使用 macOS 本机语音；如果 voice 不存在，add-tts 会尝试按语言自动 fallback。`
}

function buildGuide(args, scenario, scenarioPath, scriptPath) {
  const videoSize = scenario.recording?.videoSize || scenario.viewport || { width: 1440, height: 960 }
  const coverSize = scenario.cover || { width: 1280, height: 720 }
  const isPortrait = Number(videoSize.height) > Number(videoSize.width)
  const isEn = args.language === "en-US"
  const surfaceText = isEn
    ? scenario.primarySurface === "mobile"
      ? "Mobile portrait"
      : scenario.primarySurface === "tablet"
        ? "Tablet"
        : "Desktop landscape"
    : scenario.primarySurface === "mobile"
      ? "手机端竖屏"
      : scenario.primarySurface === "tablet"
        ? "平板端"
        : "桌面端横屏"
  const coverRatioText = Number(coverSize.height) > Number(coverSize.width)
    ? isEn ? "9:16 portrait" : "9:16 竖屏"
    : isEn ? "16:9 landscape" : "16:9 横屏"
  // 命令中直接复用 scenario.cover.* 的真实文案（按 language 已国际化），
  // 不再 hardcode 英文标题/副标题，避免用户照搬命令把中文封面覆盖成英文。
  const coverTitle = scenario.cover?.title || (isEn ? "Product Demo" : "产品演示")
  const coverSubtitle =
    scenario.cover?.subtitle ||
    (isEn
      ? scenario.primarySurface === "mobile"
        ? "Mobile product walkthrough"
        : args.audience === "customer"
          ? "Customer-ready product walkthrough"
          : "Verified product walkthrough"
      : "可验证的产品走查")
  const backupHint = scenario.data?.backupCommand
    ? isEn
      ? `Run \`data.backupCommand\` (\`${scenario.data.backupCommand}\`) before recording to back up the database.`
      : `先运行场景中的 \`data.backupCommand\` (\`${scenario.data.backupCommand}\`) 备份数据库。`
    : isEn
      ? "Replace `scenario.data.backupCommand` with the project's real backup command (e.g. `docker compose exec db pg_dump ... > backup.sql`) and run it manually before recording. The default is `null` and the runner will not back up automatically."
      : "把 `scenario.data.backupCommand` 改成你项目里实际的备份命令（例如 `docker compose exec db pg_dump ... > backup.sql`），并在录屏前手动执行；当前默认是 null，runner 不会自动备份。"

  const dataMode = scenario.data?.mode || args.dataMode
  const dataModeSection = buildDataModeSection(dataMode, scenario, isEn)
  const ttsProviderNote = buildTtsProviderNote(scenario, isEn)

  if (isEn) return buildGuideEn(args, scenario, scenarioPath, scriptPath, {
    videoSize, coverSize, isPortrait, surfaceText, coverRatioText, coverTitle, coverSubtitle, backupHint, dataMode, dataModeSection, ttsProviderNote
  })

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
- **数据来源**：\`${dataMode}\`

${dataModeSection}

## 录制前

1. **必做：替换默认占位文案**。scaffold 生成的 \`scenario.flows[].caption.title\` 是流程标签（如"核心浏览路径"），\`body\` 字段是空字符串。直接录制会让字幕/TTS 只显示/朗读 title，缺少业务价值描述。请把每一条 caption（包括 \`flow.caption\` 与 \`steps[].caption\`）的 \`body\` 改写成"这一页能解决什么业务问题"的短句，再录制。
2. **必做：扩 \`flow.steps\` 加真实业务操作**。scaffold 默认 steps 只有 \`goto\` → 三段 \`scroll\` → \`screenshot\` 这一组首页浏览骨架；raw 录屏只有 ~25 秒。要演示点击、填表、跳页面、API 写入等具体能力，请在骨架基础上加 \`click\` / \`fill\` / \`select\` / \`wait\` / \`waitForApi\` / \`db\` 等 step（模板见下方"常见 step 模板"）。
3. 确认本地服务依赖可用。如果项目依赖 PostgreSQL/Redis/外部服务（如 Tauri devUrl、worker 进程），请额外手动启动；\`scenario.server.command\` 只会启动单一 dev server。
4. 如果场景会写入数据库：${backupHint}
5. 补齐场景 JSON 里的 route、selector、\`step.waitForApi\`（API 断言）和 \`flow.assertions[].type=="db"\`（DB 落库断言，需配套写一个 \`async (params) => boolean\` 的 module）。
6. 避免真实客户数据、真实密码、token、邮箱验证码入镜；登录优先使用 dev-login + \`auth.storageState\` 或专用演示租户。
7. 如果目标观众是客户，字幕和旁白先讲客户价值，再讲可控机制；不要把 mock、fixture、临时脚本、dev warning 等内部词放进画面。
8. 如果项目同时有桌面端和手机版，手机版单独录制竖屏版本；不要把桌面横屏视频直接裁成手机视频。

## 视频太短自检

如果最终视频明显比预期短（例如只有 10-20 秒），先排查 scenario 而不是 TTS/封面：

1. \`ffprobe -v error -show_entries format=duration <flow>.mp4\` 看 **raw 录屏** 时长。raw 短就是 scenario 步骤不够，**不是** TTS / 封面 / 嵌入的问题。
2. \`<flow>-narrated.mp4\` 时长 ≈ raw 时长 + \`<flow>-narrated-narration-report.json\` 里 \`timeline.totalPaddingMs\` + 封面 intro。如果 \`totalPaddingMs\` 占了视频一半，说明 caption 文案比展示窗口长很多，画面里看到的是冻结帧。要么缩短 caption.body，要么把 \`step.caption.durationMs\` / 上下 step 间隔拉长。
3. \`<flow>-report.json\` 里 \`steps[]\` 数量应当等于 \`scenario.flows[].steps\` 数量；如果 runner 中途有 step 抛错，后面的 step 不会执行，视频随之变短。

## 常见 step 模板

骨架默认包含 \`goto/wait/caption/scroll/screenshot\`。下面是其余 step 类型的最小可用片段，按需复制到 \`flow.steps\` 里：

\`\`\`json
{ "type": "click",  "selector": "a.nav-cta", "highlightMs": 600 }
{ "type": "click",  "selector": "button[type=submit]",
  "waitForApi": { "method": "POST", "path": "/api/sources", "ok": true },
  "waitForUrl": "/sources" }
{ "type": "fill",   "selector": "#sourceName", "value": "演示·政务云招标监控" }
{ "type": "select", "selector": "#region", "optionLabel": "华东" }
{ "type": "wait",   "selector": ".job-list li", "state": "visible", "timeoutMs": 15000 }
{ "type": "wait",   "url": "/login", "timeoutMs": 15000 }
{ "type": "assert", "text": "演示·政务云招标监控", "timeoutMs": 10000 }
{ "type": "db",
  "module": "scripts/recordings/assert-source.mjs",
  "exportName": "default",
  "params": { "sourceName": "演示·政务云招标监控" } }
\`\`\`

- \`waitForApi\` 命中后会自动追加到 \`report.apiAssertions[]\`，配合 \`qualityGates.requireApiSuccess\` 校验成功率。
- \`type=db\` 由你提供一个 \`async (params) => boolean | { ok, detail }\` 的模块，结果写入 \`report.dbAssertions[]\`。
- \`scroll\` 用 \`page.mouse.wheel(x, y)\`，\`y\` 为正表示向下滚；\`durationMs\` 是滚完后的停留。
- \`waitForUrl\` 接受正则字符串，匹配 \`page.url()\`。

## 录制

\`\`\`bash
node ${scriptPath}
\`\`\`

## 增加 TTS 解说

\`\`\`bash
node <skill>/scripts/add-tts-narration.mjs --video ${args.out}/${args.name}.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-narrated.mp4 --scenario ${scenarioPath}
\`\`\`

> \`--scenario\` 让脚本从 \`${scenarioPath}\` 读取 \`narration.engine\` / \`voice\` / \`rate\` / \`padMode\` / \`padBufferMs\` 等偏好（本场景默认 \`engine=${scenario.narration.engine}\`、\`voice=${scenario.narration.voice}\`）。要换 engine/voice 时直接改 scenario，不必每次重写命令。CLI 显式 \`--engine\` / \`--voice\` 仍可临时覆盖。
> \`--pad-mode freeze\`（默认）会在某段 TTS 超过窗口长度时，自动在那段 cue 末尾插入冻结帧让配音读完，并把后续 cue 时间轴整体后移。生成的 narration-report 里有 \`timeline.totalPaddingMs\` 和每段的 \`paddingMs\` 可供查证。如果某段 padding 超过 \`--max-padding-ms\`（默认 60000）会 fail-fast，请缩短该段文案。
${ttsProviderNote}

## 多段合并与段间子封面

如果最终视频由多段 MP4 拼成，先逐段录制、逐段审片、逐段加 TTS，然后用下面命令合并。只有传入 2 段及以上时才会自动插入段间子封面；只有 1 段时脚本会直接复制输出，不增加中间转场。

\`\`\`bash
node <skill>/scripts/assemble-segmented-video.mjs --out ${args.out}/${args.name}-assembled.mp4 --segment ${args.out}/${args.name}-narrated.mp4 --segment-title "${coverTitle}" --segment-report ${args.out}/${args.name}-report.json --combined-report ${args.out}/${args.name}-assembled-report.json --transition-duration-ms ${scenario.segmentation.transitionCover.durationMs} --transition-fade-in-ms ${scenario.segmentation.transitionCover.fadeInMs} --transition-fade-out-ms ${scenario.segmentation.transitionCover.fadeOutMs}
\`\`\`

多段时为每个 segment 重复追加 \`--segment <mp4> --segment-title "下一段标题" --segment-report <json>\`。段间子封面会沿用主封面的色彩、字体和真实录屏抽帧，但强度更低，只显示 \`${scenario.segmentation.transitionCover.label}\`、下一段标题和短提示，默认约 2.4 秒，并带短淡入和柔和淡出；它是同一条 walkthrough 内的转场，不是新的片头。

## 生成封面

正式交付建议生成标准 ${coverRatioText} 封面，并先查看候选图：

\`\`\`bash
node <skill>/scripts/generate-video-cover.mjs --video ${args.out}/${args.name}-narrated.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-cover.png --title "${coverTitle}" --subtitle "${coverSubtitle}" --width ${coverSize.width} --height ${coverSize.height} --theme ${scenario.primarySurface === "mobile" ? "mobile" : args.audience === "training" ? "training" : args.audience === "customer" ? "customer" : "proof"} --candidates-dir ${args.out}/${args.name}-cover-candidates
\`\`\`

检查 \`${args.out}/${args.name}-cover-candidates/contact-sheet.png\` 后，如果自动选择的画面不够代表产品主线，使用 \`--timestamp 00:00:36\` 指定更合适的帧重新生成。

## 嵌入视频封面

MP4 封面 PNG 必须作为 \`attached_pic\` 嵌入最终视频，否则很多播放器/网盘/审片工具不会把它当作缩略图。该命令支持原地写回：

\`\`\`bash
node <skill>/scripts/embed-video-cover.mjs --video ${args.out}/${args.name}-narrated.mp4 --cover ${args.out}/${args.name}-cover.png --out ${args.out}/${args.name}-narrated.mp4 --intro-duration-ms 2000 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --narration-vtt ${args.out}/${args.name}-narrated-narration.vtt --report ${args.out}/${args.name}-cover-embed-report.json
\`\`\`

> \`attached_pic\` 是播放器缩略图元数据，不等于所有播放器都会在播放前显示封面。\`--intro-duration-ms 2000\` 会额外把封面写成 2 秒真实视频开场，并同步后移 narration VTT/report；如果只要文件元数据封面，可去掉该参数。

如果封面后仍出现 loading、白屏或等待空白，抽帧确认空白范围后删除该段。示例表示保留前 2 秒封面，删除 \`2.0s-8.5s\` 的空白：

\`\`\`bash
node <skill>/scripts/trim-video-gap.mjs --video ${args.out}/${args.name}-narrated.mp4 --cover ${args.out}/${args.name}-cover.png --out ${args.out}/${args.name}-narrated.mp4 --remove-start-ms 2000 --remove-end-ms 8500 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --narration-vtt ${args.out}/${args.name}-narrated-narration.vtt --report ${args.out}/${args.name}-gap-trim-report.json
\`\`\`

## 质量门禁

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --require-audio --require-cover-art --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

如果使用默认 TTS 输出名，建议把 narration report 一并纳入时长校验：

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --require-audio --require-cover-art --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

## 审片页面

\`\`\`bash
node <skill>/scripts/generate-review-page.mjs --report ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --media-report ${args.out}/${args.name}-media-report.json --cover ${args.out}/${args.name}-cover.png --cover-candidates ${args.out}/${args.name}-cover-candidates --frame-review ${args.out}/${args.name}-frame-review --out ${args.out}/${args.name}-review.html
\`\`\`

## 基础包装导出

\`\`\`bash
node <skill>/scripts/polish-video.mjs --video ${args.out}/${args.name}-narrated.mp4 --out ${args.out}/${args.name}-polished.mp4 --preset ${scenario.postProduction.polishPreset}
\`\`\`

如果需要 Screen Studio 级别的自然缩放、光标平滑、设备框或手动时间线编辑，先生成交接包：

\`\`\`bash
node <skill>/scripts/prepare-screen-studio-handoff.mjs --out ${args.out}/${args.name}-screen-studio-handoff --target ${scenario.postProduction.screenStudioTarget} --raw-video ${args.out}/${args.name}.mp4 --narrated-video ${args.out}/${args.name}-narrated.mp4 --report ${args.out}/${args.name}-report.json --scenario ${args.out}/${args.name}.scenario.json --vtt ${args.out}/${args.name}-narrated-narration.vtt --cover ${args.out}/${args.name}-cover.png --frame-review ${args.out}/${args.name}-frame-review --cover-candidates ${args.out}/${args.name}-cover-candidates
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

function buildGuideEn(args, scenario, scenarioPath, scriptPath, ctx) {
  const { videoSize, coverSize, isPortrait, surfaceText, coverRatioText, coverTitle, coverSubtitle, backupHint, dataMode, dataModeSection, ttsProviderNote } = ctx
  return `# Recording Guide

## Overview

- Scenario: \`${args.name}\`
- Scenario file: \`${scenarioPath}\`
- Runner: \`${scriptPath}\`
- Subtitles: \`${args.subtitles}\`
- Language: \`${args.language}\`
- Flows: \`${args.flows.join(", ")}\`
- Audience: \`${args.audience}\`
- Polish: \`${args.polish}\`
- Surface: \`${surfaceText}\`
- Video size: \`${videoSize.width}x${videoSize.height}\`
- Cover size: \`${coverSize.width}x${coverSize.height}\`
- **Data source**: \`${dataMode}\`

${dataModeSection}

## Before Recording

1. **Required: replace the placeholder caption text.** The scaffold leaves \`scenario.flows[].caption.body\` (and \`steps[].caption.body\`) empty. Captions will then show only the title and TTS will only narrate the title. Edit every caption \`body\` into a short business-value sentence before recording.
2. **Required: extend \`flow.steps\` with real product actions.** The default steps are just \`goto\` → three \`scroll\` blocks → \`screenshot\` (a landing-only browse, ~25s raw). Add \`click\` / \`fill\` / \`select\` / \`wait\` / \`waitForApi\` / \`db\` to demonstrate clicks, form submission, navigation, and writes — see "Common step templates" below.
3. Make sure local dependencies are running. If the project needs PostgreSQL/Redis/workers/Tauri devUrl, start them manually; \`scenario.server.command\` only launches a single dev server.
4. If the flow writes to the database: ${backupHint}
5. Fill in real routes, selectors, \`step.waitForApi\` (API assertions), and \`flow.assertions[].type=="db"\` (DB assertions; supply an \`async (params) => boolean\` module).
6. Never record real customer data, real passwords, tokens or 2FA codes. Prefer dev-login + \`auth.storageState\` or a dedicated demo tenant.
7. For customer audiences keep captions/narration value-first; do not write \`mock\`, \`fixture\`, \`renderer-only\`, internal boundary names or dev warnings into the on-screen text.
8. Record desktop and mobile separately when the product ships on both surfaces; do not crop a desktop recording into a mobile portrait video.

## Why is my video so short?

If the final video is much shorter than expected (e.g. only 10-20s), inspect the scenario first, not the TTS / cover pipeline:

1. \`ffprobe -v error -show_entries format=duration <flow>.mp4\` shows the **raw recording** duration. If raw is short, the scenario lacks steps — not a TTS / cover / embed bug.
2. \`<flow>-narrated.mp4\` duration ≈ raw duration + \`timeline.totalPaddingMs\` (from \`<flow>-narrated-narration-report.json\`) + cover intro. If \`totalPaddingMs\` accounts for half the video, your caption text is longer than the display window and you're watching freeze frames — shorten \`caption.body\` or widen the gap between steps.
3. \`<flow>-report.json\` \`steps[]\` count should equal the scenario steps. If the runner threw mid-flow, subsequent steps never ran and the video gets cut short.

## Common step templates

The default skeleton covers \`goto/wait/caption/scroll/screenshot\`. Drop these into \`flow.steps\` as needed:

\`\`\`json
{ "type": "click",  "selector": "a.nav-cta", "highlightMs": 600 }
{ "type": "click",  "selector": "button[type=submit]",
  "waitForApi": { "method": "POST", "path": "/api/sources", "ok": true },
  "waitForUrl": "/sources" }
{ "type": "fill",   "selector": "#sourceName", "value": "Demo: GovCloud Tender Monitor" }
{ "type": "select", "selector": "#region", "optionLabel": "East" }
{ "type": "wait",   "selector": ".job-list li", "state": "visible", "timeoutMs": 15000 }
{ "type": "wait",   "url": "/login", "timeoutMs": 15000 }
{ "type": "assert", "text": "Demo: GovCloud Tender Monitor", "timeoutMs": 10000 }
{ "type": "db",
  "module": "scripts/recordings/assert-source.mjs",
  "exportName": "default",
  "params": { "sourceName": "Demo: GovCloud Tender Monitor" } }
\`\`\`

- \`waitForApi\` hits are appended to \`report.apiAssertions[]\` for \`qualityGates.requireApiSuccess\`.
- \`type=db\` calls a user module that returns \`boolean | { ok, detail }\`; results land in \`report.dbAssertions[]\`.
- \`scroll\` uses \`page.mouse.wheel(x, y)\` — positive \`y\` scrolls down; \`durationMs\` is the pause after the scroll.
- \`waitForUrl\` is a regex string matched against \`page.url()\`.

## Record

\`\`\`bash
node ${scriptPath}
\`\`\`

## Add TTS Narration

\`\`\`bash
node <skill>/scripts/add-tts-narration.mjs --video ${args.out}/${args.name}.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-narrated.mp4 --scenario ${scenarioPath}
\`\`\`

> \`--scenario\` makes the script read \`narration.engine\` / \`voice\` / \`rate\` / \`padMode\` / \`padBufferMs\` from \`${scenarioPath}\` (this scenario defaults to \`engine=${scenario.narration.engine}\`, \`voice=${scenario.narration.voice}\`). Change the engine or voice by editing the scenario; you don't need to rewrite the command every time. Explicit CLI flags (e.g. \`--engine\`, \`--voice\`) still override.
> \`--pad-mode freeze\` (default) inserts cloned freeze frames at the end of any cue whose TTS audio is longer than its display window, and shifts subsequent cues. The narration-report exposes \`timeline.totalPaddingMs\` and per-cue \`paddingMs\`. A cue that needs more than \`--max-padding-ms\` (default 60000) fails fast; shorten that cue's text.
${ttsProviderNote}

## Assemble Segments And In-Video Transition Covers

If the final video is assembled from multiple MP4 segments, record, review, and narrate each segment first, then merge them with this command. The script only inserts in-between transition covers when it receives 2+ segments; with a single segment it copies the video through without adding a middle slate.

\`\`\`bash
node <skill>/scripts/assemble-segmented-video.mjs --out ${args.out}/${args.name}-assembled.mp4 --segment ${args.out}/${args.name}-narrated.mp4 --segment-title "${coverTitle}" --segment-report ${args.out}/${args.name}-report.json --combined-report ${args.out}/${args.name}-assembled-report.json --transition-duration-ms ${scenario.segmentation.transitionCover.durationMs} --transition-fade-in-ms ${scenario.segmentation.transitionCover.fadeInMs} --transition-fade-out-ms ${scenario.segmentation.transitionCover.fadeOutMs}
\`\`\`

For multiple segments, repeat \`--segment <mp4> --segment-title "Next segment title" --segment-report <json>\` in playback order. The transition cover reuses the main cover's color, type, and real recording frames, but stays lower-intensity: it shows \`${scenario.segmentation.transitionCover.label}\`, the next segment title, and one short line for about 2.4s with a short fade-in and softer fade-out. Treat it as a handoff inside one walkthrough, not a second intro.

## Generate Cover

Formal delivery should produce a standard ${coverRatioText} cover with candidate review:

\`\`\`bash
node <skill>/scripts/generate-video-cover.mjs --video ${args.out}/${args.name}-narrated.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-cover.png --title "${coverTitle}" --subtitle "${coverSubtitle}" --width ${coverSize.width} --height ${coverSize.height} --theme ${scenario.primarySurface === "mobile" ? "mobile" : args.audience === "training" ? "training" : args.audience === "customer" ? "customer" : "proof"} --candidates-dir ${args.out}/${args.name}-cover-candidates
\`\`\`

Open \`${args.out}/${args.name}-cover-candidates/contact-sheet.png\`. If the auto-picked frame is not representative, pass \`--timestamp 00:00:36\` (or any HH:MM:SS) and rerun.

## Embed Cover Into MP4

The MP4 cover PNG must be muxed in as the \`attached_pic\` stream so players, drive previews, and review tools treat it as the thumbnail. The command supports in-place output:

\`\`\`bash
node <skill>/scripts/embed-video-cover.mjs --video ${args.out}/${args.name}-narrated.mp4 --cover ${args.out}/${args.name}-cover.png --out ${args.out}/${args.name}-narrated.mp4 --intro-duration-ms 2000 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --narration-vtt ${args.out}/${args.name}-narrated-narration.vtt --report ${args.out}/${args.name}-cover-embed-report.json
\`\`\`

> \`attached_pic\` is metadata; not every browser/QuickTime/drive preview will use it as the pre-play poster. \`--intro-duration-ms 2000\` also prepends 2 visible seconds of the cover frame and shifts the narration VTT/report. Drop the flag if you only need the metadata cover.

If the cover slate is followed by a blank/loading gap, remove that range and keep the narration files in sync:

\`\`\`bash
node <skill>/scripts/trim-video-gap.mjs --video ${args.out}/${args.name}-narrated.mp4 --cover ${args.out}/${args.name}-cover.png --out ${args.out}/${args.name}-narrated.mp4 --remove-start-ms 2000 --remove-end-ms 8500 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --narration-vtt ${args.out}/${args.name}-narrated-narration.vtt --report ${args.out}/${args.name}-gap-trim-report.json
\`\`\`

## Quality Gates

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --require-audio --require-cover-art --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

For TTS output also pass the narration report so duration drift is checked:

\`\`\`bash
node <skill>/scripts/validate-recording-report.mjs ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --source-video ${args.out}/${args.name}.mp4 --narration-report ${args.out}/${args.name}-narrated-narration-report.json --require-audio --require-cover-art --expect-width ${videoSize.width} --expect-height ${videoSize.height} --write-media-report ${args.out}/${args.name}-media-report.json --write-frame-review ${args.out}/${args.name}-frame-review
\`\`\`

## Review Page

\`\`\`bash
node <skill>/scripts/generate-review-page.mjs --report ${args.out}/${args.name}-report.json --video ${args.out}/${args.name}-narrated.mp4 --media-report ${args.out}/${args.name}-media-report.json --cover ${args.out}/${args.name}-cover.png --cover-candidates ${args.out}/${args.name}-cover-candidates --frame-review ${args.out}/${args.name}-frame-review --out ${args.out}/${args.name}-review.html
\`\`\`

## Polish / Screen Studio Handoff

\`\`\`bash
node <skill>/scripts/polish-video.mjs --video ${args.out}/${args.name}-narrated.mp4 --out ${args.out}/${args.name}-polished.mp4 --preset ${scenario.postProduction.polishPreset}
\`\`\`

If you need Screen Studio-level zoom, cursor smoothing, device frames, or timeline edits, build the handoff bundle first:

\`\`\`bash
node <skill>/scripts/prepare-screen-studio-handoff.mjs --out ${args.out}/${args.name}-screen-studio-handoff --target ${scenario.postProduction.screenStudioTarget} --raw-video ${args.out}/${args.name}.mp4 --narrated-video ${args.out}/${args.name}-narrated.mp4 --report ${args.out}/${args.name}-report.json --scenario ${args.out}/${args.name}.scenario.json --vtt ${args.out}/${args.name}-narrated-narration.vtt --cover ${args.out}/${args.name}-cover.png --frame-review ${args.out}/${args.name}-frame-review --cover-candidates ${args.out}/${args.name}-cover-candidates
\`\`\`

## Caption Rules

- Describe the business problem this screen solves; do not explain the script.
- Keep each caption to 1-2 lines; avoid form inputs and primary CTAs.
- Highlights are visual cues only; clear them before any click/fill.
${isPortrait ? "- Portrait mobile captions sit in the bottom safe area but must avoid the bottom nav, inputs, and primary CTA.\n" : ""}

## Overlay Polish

- Overlays stay anchored at their final position. Only short \`opacity\` transitions are allowed.
- Do not animate captions/chapters with \`translateY/translateX/scale/clip-path\`.
- Record \`caption.startMs\` only after the overlay has settled; record \`endMs\` before hiding and wait for the transition to end.
- For formal delivery, inspect \`${args.out}/${args.name}-frame-review/contact-sheet.png\` for half-rendered overlays or occluded controls.
- Inspect \`${args.out}/${args.name}-cover.png\` and confirm the product name/topic is legible, the UI screenshot is real, and the cover does not leak internal terminology.
`
}

// runner 源码独立放在 scripts/templates/playwright-runner.mjs，便于直接 lint / IDE 跳转，
// 不再是巨大的字符串模板嵌入。scaffold 时把两个占位字符串替换为真实路径。
const __scaffoldFile = fileURLToPath(import.meta.url)
const RUNNER_TEMPLATE_PATH = path.resolve(
  path.dirname(__scaffoldFile),
  "templates",
  "playwright-runner.mjs"
)

async function buildRunner(scenarioRelativePath, scriptToRootRelative) {
  const template = await readFile(RUNNER_TEMPLATE_PATH, "utf8")
  return template
    .replace("__SCRIPT_TO_ROOT_RELATIVE__", scriptToRootRelative.replace(/\\/g, "\\\\").replace(/"/g, "\\\""))
    .replace("__SCENARIO_RELATIVE__", scenarioRelativePath.replace(/\\/g, "\\\\").replace(/"/g, "\\\""))
}

async function maybeWarnGitignore(rootDir, outRelative) {
  const gitignorePath = path.join(rootDir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    console.warn(
      `[scaffold] 提醒：仓库没有 .gitignore，录屏产物 (${outRelative}/*.mp4、*.webm、frame-review/、cover-candidates/) 体积可能很大，建议显式忽略以免误 commit。`
    )
    return
  }
  try {
    const text = await readFile(gitignorePath, "utf8")
    if (!text.split(/\r?\n/).some((line) => line.trim() === outRelative || line.trim() === `${outRelative}/` || line.includes("*.mp4"))) {
      console.warn(
        `[scaffold] 提醒：.gitignore 没有忽略 ${outRelative} 或 *.mp4。录屏产物可能很大，建议手动添加：\n  ${outRelative}/*.mp4\n  ${outRelative}/*.webm\n  ${outRelative}/*-frame-review/\n  ${outRelative}/*-cover-candidates/`
      )
    }
  } catch {
    // ignore
  }
}

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root)
const detection = await detectProject(root)

if (detection.warnings.length > 0) {
  for (const warning of detection.warnings) {
    console.warn(`[scaffold] ${warning}`)
  }
}

// 用 detection 推断的 baseUrl 填充用户未提供的值
if (!args.baseUrl) {
  args.baseUrl = detection.baseUrl || "http://localhost:3000"
  if (detection.baseUrl) {
    console.log(`[scaffold] 已根据项目自动检测 baseUrl：${args.baseUrl}（如需要请改用 --base-url）`)
  } else {
    console.warn(
      `[scaffold] 未能从项目自动检测 baseUrl，使用回退值 ${args.baseUrl}。请用 --base-url 覆盖或编辑 scenario.json 中的 baseUrl 字段。`
    )
  }
}

const outputDir = path.resolve(root, args.out)
const scriptDir = path.resolve(root, "scripts/recordings")
const scenarioPath = path.join(outputDir, `${args.name}.scenario.json`)
const scriptPath = path.join(scriptDir, `${args.name}.mjs`)
const guidePath = path.join(outputDir, "RECORDING_GUIDE.md")
const scenarioRelativePath = path.relative(root, scenarioPath)
const scriptRelativePath = path.relative(root, scriptPath)
const guideRelativePath = path.relative(root, guidePath)
const scriptToRootRelative = path.relative(path.dirname(scriptPath), root) || "."
const scenario = buildScenario(args, detection)

await writeNew(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, args.force)
await writeNew(scriptPath, await buildRunner(scenarioRelativePath, scriptToRootRelative), args.force)

const guideExists = await exists(guidePath)
let guideAction = "skipped"
if (!guideExists) {
  await writeFile(guidePath, buildGuide(args, scenario, scenarioRelativePath, scriptRelativePath))
  guideAction = "created"
} else if (args.force) {
  await writeFile(guidePath, buildGuide(args, scenario, scenarioRelativePath, scriptRelativePath))
  guideAction = "overwritten"
}

await maybeWarnGitignore(root, args.out)

// 用户传 `--flows core,mobile` 但 surface=auto 时，scaffold 推断 primarySurface=desktop，
// mobile flow 在桌面 viewport 下录制，效果完全不像手机版。SKILL.md 也明确说"桌面端和手机版应优先
// 分别录制"。这里给出明确警告 + 建议命令。
if (scenario.primarySurface !== "mobile" && args.flows.includes("mobile")) {
  console.warn(
    `[scaffold] 提醒：flow 列表包含 "mobile"，但当前主端是 "${scenario.primarySurface}"。\n` +
      `  这条 mobile flow 仍然会在桌面 viewport 下录制，看起来不像手机端 demo。\n` +
      `  推荐：另外跑一次 scaffold 单独生成手机版录屏：\n` +
      `    node <skill>/scripts/scaffold-repo-demo.mjs --root . --name ${args.name}-mobile --surface mobile --flows mobile --base-url ${args.baseUrl}\n` +
      `  或者把当前的 --surface 改成 mobile 录纯手机端版本。`
  )
}

// 用户传 `--surface multi` 时只生成桌面录屏脚本（primarySurface=desktop fallback）。
// 多端项目需要分别生成桌面和手机两份；提醒用户继续跑一次手机版。
if (scenario.surface === "multi") {
  console.warn(
    `[scaffold] 提醒：--surface=multi 只会生成一份基于 "${scenario.primarySurface}" 的录屏脚本。\n` +
      `  请再跑一次手机版以生成竖屏录屏：\n` +
      `    node <skill>/scripts/scaffold-repo-demo.mjs --root . --name ${args.name}-mobile --surface mobile --flows mobile --base-url ${args.baseUrl}`
  )
}

console.log(`已生成录屏场景：${scenarioRelativePath}`)
console.log(`已生成录屏脚本：${scriptRelativePath}`)
console.log(`录屏指南 (${guideAction})：${guideRelativePath}`)
if (detection.kind === "ios" || detection.kind === "android") {
  console.warn(
    "[scaffold] generated runner 在原生 App 项目下不会工作；scenario 中的 server/auth/healthPath 字段对你无意义，请删除或忽略，转走外部录屏接入工作流（见 SKILL.md）。"
  )
}
