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
  force: false
}

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

    const key = toCamelCase(token.slice(2))
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
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

function buildScenario(args, detection = null) {
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
  const isZh = args.language !== "en-US"
  // 中文场景下默认用中文文案，避免封面/字幕里突然冒出英文造成违和
  const coverDefaults = isZh
    ? {
        customerDesktop: {
          title: "产品演示",
          subtitle: "面向客户的可发版走查",
          line: "首页 · 搜索 · 自动化",
          badge: "客户演示"
        },
        customerMobile: {
          title: "移动端演示",
          subtitle: "移动端产品走查",
          line: "竖屏 UI · 触控流程 · 移动端字幕",
          badge: "移动端演示"
        },
        proof: {
          title: "项目演示",
          subtitle: "可验证的产品走查",
          line: "脚本录制 · 字幕 · 质量报告",
          badge: "已验证演示"
        },
        training: {
          title: "操作培训",
          subtitle: "面向新成员的步骤讲解",
          line: "字段含义 · 操作顺序 · 验收点",
          badge: "培训 SOP"
        }
      }
    : {
        customerDesktop: {
          title: "Product Demo",
          subtitle: "Customer-ready product walkthrough",
          line: "Home · Search · Automation",
          badge: "CUSTOMER DEMO"
        },
        customerMobile: {
          title: "Mobile Product Demo",
          subtitle: "Mobile product walkthrough",
          line: "Portrait UI · Touch flow · Mobile captions",
          badge: "MOBILE DEMO"
        },
        proof: {
          title: "Verified Demo",
          subtitle: "Verified product walkthrough",
          line: "Scripted recording · Captions · Quality report",
          badge: "VERIFIED DEMO"
        },
        training: {
          title: "Training Walkthrough",
          subtitle: "Step-by-step training",
          line: "Fields · Steps · Acceptance",
          badge: "TRAINING"
        }
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
      // 正式交付及以上默认启用 TTS：与 SKILL.md "对正式 demo 默认生成 transcript/VTT，再用本地 TTS 合成" 对齐。
      enabled: args.polish !== "quick-proof",
      // customer audience 优先 edge-tts（联网）以追求自然语音；其他 audience 默认本机 macOS say，避免把内部 demo 文本送到第三方服务。
      engine: args.audience === "customer" ? "edge-tts" : "macos-say",
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
      rerecordOnFailure: args.polish === "customer-ready"
    },
    // auth 字段保留 storageState（runner 唯一会读的字段）；mode/endpoint/payload 留作人工 review 提示，
    // 仅在 dev-login 流程里手动填充。runner 不会自动调用 endpoint。
    auth: {
      mode: "manual-or-dev-login",
      storageState: null,
      // 如果你的项目有 dev-login API，可补 endpoint/payload，并在 flow.steps 中加一段
      // { type: "goto", url: endpoint } 或自定义脚本去调用 fetch；runner 不会自动用它们。
      endpoint: null,
      payload: null
    },
    data: {
      strategy: args.flows.some((flow) => flow.includes("data")) ? "ui-write" : "readonly",
      // backupCommand 仅在写入型录屏前提示用户运行；不会被 runner 自动调用。请改成项目实际的备份命令或设为 null。
      backupCommand: null,
      seedCommand: null,
      demoPrefix: isZh ? "演示" : "demo",
      cleanup: false
    },
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
      gapTrimReport: args.polish !== "quick-proof"
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
  // 命令中直接复用 scenario.cover.* 的真实文案（按 language 已国际化），
  // 不再 hardcode 英文标题/副标题，避免用户照搬命令把中文封面覆盖成英文。
  const coverTitle = scenario.cover?.title || (args.language === "en-US" ? "Product Demo" : "产品演示")
  const coverSubtitle =
    scenario.cover?.subtitle ||
    (args.language === "en-US"
      ? scenario.primarySurface === "mobile"
        ? "Mobile product walkthrough"
        : args.audience === "customer"
          ? "Customer-ready product walkthrough"
          : "Verified product walkthrough"
      : "可验证的产品走查")
  const backupHint = scenario.data?.backupCommand
    ? `先运行场景中的 \`data.backupCommand\` (\`${scenario.data.backupCommand}\`) 备份数据库。`
    : "把 `scenario.data.backupCommand` 改成你项目里实际的备份命令（例如 `docker compose exec db pg_dump ... > backup.sql`），并在录屏前手动执行；当前默认是 null，runner 不会自动备份。"

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

1. 确认本地服务依赖可用。如果项目依赖 PostgreSQL/Redis/外部服务（如 Tauri devUrl、worker 进程），请额外手动启动；\`scenario.server.command\` 只会启动单一 dev server。
2. 如果场景会写入数据库：${backupHint}
3. 补齐场景 JSON 里的 route、selector、\`step.waitForApi\`（API 断言）和 \`flow.assertions[].type=="db"\`（DB 落库断言，需配套写一个 \`async (params) => boolean\` 的 module）。
4. 避免真实客户数据、真实密码、token、邮箱验证码入镜；登录优先使用 dev-login + \`auth.storageState\` 或专用演示租户。
5. 如果目标观众是客户，字幕和旁白先讲客户价值，再讲可控机制；不要把 mock、fixture、临时脚本、dev warning 等内部词放进画面。
6. 如果项目同时有桌面端和手机版，手机版单独录制竖屏版本；不要把桌面横屏视频直接裁成手机视频。

## 录制

\`\`\`bash
node ${scriptPath}
\`\`\`

## 增加 TTS 解说

\`\`\`bash
node <skill>/scripts/add-tts-narration.mjs --video ${args.out}/${args.name}.mp4 --report ${args.out}/${args.name}-report.json --out ${args.out}/${args.name}-narrated.mp4 --language ${args.language} --engine edge-tts --voice ${scenario.narration.voice} --pad-mode freeze --pad-buffer-ms 300
\`\`\`

> \`--pad-mode freeze\`（默认）会在某段 TTS 超过窗口长度时，自动在那段 cue 末尾插入冻结帧让配音读完，并把后续 cue 时间轴整体后移。生成的 narration-report 里有 \`timeline.totalPaddingMs\` 和每段的 \`paddingMs\` 可供查证。如果某段 padding 超过 \`--max-padding-ms\`（默认 60000）会 fail-fast，请缩短该段文案。
> \`--engine edge-tts\` 需要 \`uvx\` 和网络，会把解说文本发送到 Microsoft Edge online TTS。不能使用在线 TTS 时，可改为 \`--engine macos-say --voice Tingting\`。

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

console.log(`已生成录屏场景：${scenarioRelativePath}`)
console.log(`已生成录屏脚本：${scriptRelativePath}`)
console.log(`录屏指南 (${guideAction})：${guideRelativePath}`)
if (detection.kind === "ios" || detection.kind === "android") {
  console.warn(
    "[scaffold] generated runner 在原生 App 项目下不会工作；scenario 中的 server/auth/healthPath 字段对你无意义，请删除或忽略，转走外部录屏接入工作流（见 SKILL.md）。"
  )
}
