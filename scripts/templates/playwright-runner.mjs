#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { chromium } from "playwright"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "__SCRIPT_TO_ROOT_RELATIVE__")
const scenarioPath = path.resolve(projectRoot, "__SCENARIO_RELATIVE__")
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
  // 把 narrative.avoidVisibleTerms 与 qualityGates 沉淀到 report，
  // 这样 validate-recording-report.mjs 不依赖原 scenario 也能继续做字幕禁词/允许清单校验。
  narrative: scenario.narrative || null,
  qualityGates: scenario.qualityGates || null,
  demoData: {},
  captions: [],
  steps: [],
  // step.waitForApi 命中的每个 response 自动追加到这里，配合 qualityGates.requireApiSuccess 校验。
  apiAssertions: [],
  // type=="db" 断言由 runner 执行（先 require 用户提供的 dbAssertion executor 或当场跑 prisma/sqlite）；
  // 未提供执行能力时记录为 ok=false 并附原因，validate 端可以读到。
  dbAssertions: [],
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

const RECORDER_STYLES = `
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
`

// 浏览器初始化用 try/catch 包起来：如果 newContext / addInitScript / newPage 中途抛错（例如
// recordVideo 目录权限错、storageState 文件不存在），上一步已经创建的 browser/context 必须被关掉
// 才不会留下僵尸 Chromium 进程。
let browser = null
let context = null
try {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({
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
} catch (error) {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  throw error
}

let page = null
try {
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

page = await context.newPage()
} catch (error) {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  throw error
}
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
  throw new Error(`Timed out waiting for dev server: ${url}`)
}

async function ensureServer() {
  const healthUrl = new URL(scenario.server?.healthPath || "/", scenario.baseUrl).toString()
  if (await isServing(healthUrl)) {
    // 历史踩坑：端口被另一个无关项目占用时，isServing 依然返回 true（任何 <500 都算 serving），
    // 然后 runner 跳过启动新 server，最终把"另一个项目"录进了视频，且因为是录到了别人，
    // 用户事后追查也很难定位。这里给一条明确警告，让用户能立刻意识到差异。
    console.warn(
      `[recorder] 已检测到 ${healthUrl} 响应（<500），跳过启动 scenario.server.command。\n` +
        `  如果该端口当前监听的是其它项目（不是本 scenario 所在仓库的 dev server），请：\n` +
        `  1) 关闭占用端口的进程，或者 2) 改 scenario.baseUrl 到一个空闲端口（推荐用 \`PORT=xxxx ${scenario.server?.command || "npm run dev"}\` 启动）。\n` +
        `  否则录到的内容可能与你预期不一致。`
    )
    return
  }
  if (!scenario.server?.command) {
    throw new Error(`No server is listening at ${healthUrl}, and scenario.server.command is empty`)
  }
  // detached:true 让 shell + 它启动的实际 dev server（pnpm → vite 等）共享一个新的进程组，
  // stopServer 通过 process.kill(-pid, ...) 一次性把整个组杀掉，避免端口残留。
  const child = spawn(scenario.server.command, {
    cwd: projectRoot,
    shell: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  startedServer = child
  child.stdout.on("data", (chunk) => process.stdout.write(`[demo-server] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[demo-server] ${chunk}`))

  // 进程被异常退出时（Ctrl+C / 录制异常），尽量保证不留端口监听
  const cleanup = () => {
    void stopServer()
  }
  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)
  process.once("exit", () => {
    if (startedServer && process.platform !== "win32") {
      try {
        process.kill(-startedServer.pid, "SIGKILL")
      } catch {
        // ignore
      }
    }
  })
  await waitForServer(healthUrl, Number(scenario.server?.startupTimeoutMs) || 120_000)
}

async function stopServer() {
  if (!startedServer) return
  const child = startedServer
  startedServer = null
  try {
    if (process.platform === "win32") {
      // Windows 没有 process group；尽力杀掉直接子进程并依赖 shell 终止链
      child.kill("SIGTERM")
    } else if (child.pid != null) {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        try {
          child.kill("SIGTERM")
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 650))
  if (!child.killed) {
    try {
      if (process.platform === "win32") {
        child.kill("SIGKILL")
      } else if (child.pid != null) {
        process.kill(-child.pid, "SIGKILL")
      }
    } catch {
      // ignore
    }
  }
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
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

function buildVtt(captions) {
  const cues = captions.map((item, index) => {
    const text = [item.title, item.body].filter(Boolean).join("\n")
    return `${index + 1}\n${formatVttTime(item.startMs || 0)} --> ${formatVttTime(item.endMs || 0)}\n${text}`
  })
  return `WEBVTT\n\n${cues.join("\n\n")}\n`
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

async function waitForApi(waitForApi, action, label) {
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
  const response = await responsePromise
  // 把成功命中的 API 断言写到 report.apiAssertions[]，供 validate-recording-report.mjs 的
  // qualityGates.requireApiSuccess 校验使用；之前这条记录从未生成，导致 requireApiSuccess=true
  // 时 validate 永远 fail。
  try {
    report.apiAssertions.push({
      label: label || null,
      method: response.request().method(),
      path: waitForApi.path || null,
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      atMs: elapsed()
    })
  } catch {
    // ignore
  }
  return response
}

async function runDbAssertion(assertion, label) {
  // type=="db" 断言的最小执行模型：用户在 scenario 中提供 module/exportName 指向项目内的
  // assert 函数（async (params) => boolean | { ok, detail }）。runner 不再硬编码 Prisma/SQLite，
  // 这样能兼容 Prisma、Drizzle、Knex、原生 pg/sqlite 等任意客户端。
  if (!assertion || !assertion.module) {
    report.dbAssertions.push({
      label,
      ok: false,
      reason:
        "DB 断言需要在 assertion 中提供 module 字段，指向项目内的 async 函数。runner 不会自动连数据库，请在 scenario 中补：{ type: 'db', module: 'scripts/assert-source.mjs', exportName: 'default', params: {...} }"
    })
    return
  }
  try {
    const modulePath = path.resolve(projectRoot, assertion.module)
    const mod = await import(pathToFileURL(modulePath).href)
    const fn = assertion.exportName ? mod[assertion.exportName] : mod.default
    if (typeof fn !== "function") {
      report.dbAssertions.push({
        label,
        ok: false,
        reason: `DB 断言模块 ${assertion.module} 中找不到 ${assertion.exportName || "default"} 导出`
      })
      return
    }
    const result = await fn(assertion.params || {})
    if (typeof result === "boolean") {
      report.dbAssertions.push({ label, ok: result })
    } else {
      report.dbAssertions.push({
        label,
        ok: Boolean(result?.ok),
        detail: result?.detail ?? null
      })
    }
  } catch (error) {
    report.dbAssertions.push({ label, ok: false, reason: String(error?.message || error) })
  }
}

async function runStep(flow, step, index) {
  const label = step.label || `${flow.id}-${index + 1}-${step.type}`

  if (step.caption) {
    await caption(
      step.caption.title || flow.caption?.title || label,
      step.caption.body || step.caption,
      step.caption.durationMs || 2200
    )
  }

  if (step.type === "goto") {
    await clearHighlight()
    // Next.js / Tauri 等 dev 模式有 HMR/long-poll，networkidle 经常永远不到，整个 runner 卡死。
    // 默认改用 domcontentloaded；项目稳定后可在 step.waitUntil 中显式覆盖（"load" / "networkidle"）。
    await page.goto(new URL(step.url || step.route || flow.route || "/", scenario.baseUrl).toString(), {
      waitUntil: step.waitUntil || scenario.navigation?.waitUntil || "domcontentloaded",
      timeout: step.gotoTimeoutMs || scenario.navigation?.gotoTimeoutMs || 30_000
    })
  } else if (step.type === "chapter") {
    await chapter(step.title || flow.caption?.title || label, step.body || flow.caption?.body || "", step.durationMs || 1250)
  } else if (step.type === "caption") {
    await caption(step.title || flow.caption?.title || label, step.body || flow.caption?.body || "", step.durationMs || 3000)
  } else if (step.type === "click") {
    const locator = await highlight(step.selector, step.highlightMs || 300)
    await clearHighlight()
    await waitForApi(
      step.waitForApi,
      async () => {
        await locator.click({ delay: step.delayMs || 40 })
      },
      label
    )
    if (step.waitForUrl) {
      await page.waitForURL(new RegExp(step.waitForUrl), { timeout: step.timeoutMs || 20_000 })
    }
  } else if (step.type === "db") {
    // 写入型 demo 在客户/QA 录屏后做 DB 落库验证；step 指向项目内的 assert 函数，
    // 详细约定见 runDbAssertion 上方注释。
    await clearHighlight()
    await runDbAssertion(step, label)
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
    await page.screenshot({ path: path.join(outputDir, `${scenario.name}-${step.name || label}.png`), fullPage: true })
  } else if (step.type === "assert") {
    await clearHighlight()
    if (step.text) {
      await page.getByText(step.text, { exact: Boolean(step.exact) }).first().waitFor({ timeout: step.timeoutMs || 10_000 })
    }
  } else {
    throw new Error(`未知 step 类型：${step.type}`)
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
      else reject(new Error(`ffmpeg failed (status=${code})\n${stderr.slice(-2000)}`))
    })
  })
}

async function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      filePath
    ])
    let stdout = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.on("error", () => resolve(false))
    child.on("close", () => resolve(stdout.trim().length > 0))
  })
}

async function convertToMp4(webmPath, mp4Path) {
  const hasAudio = await probeHasAudio(webmPath)
  const ffmpegArgs = [
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
    "veryfast"
  ]
  if (hasAudio) {
    ffmpegArgs.push("-c:a", "aac", "-b:a", "160k")
  } else {
    ffmpegArgs.push("-an")
  }
  ffmpegArgs.push(mp4Path)
  await runFfmpeg(ffmpegArgs)
}

try {
  await ensureServer()
  await page.goto(scenario.baseUrl, { waitUntil: "domcontentloaded" })

  for (const flow of scenario.flows || []) {
    await page.goto(new URL(flow.route || "/", scenario.baseUrl).toString(), {
      waitUntil: scenario.navigation?.waitUntil || "domcontentloaded",
      timeout: scenario.navigation?.gotoTimeoutMs || 30_000
    })
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
      } else if (assertion.type === "db") {
        await runDbAssertion(assertion, `${flow.id}-assertion-db`)
      }
    }
  }

  await clearHighlight()
  if (scenario.outputs?.finalScreenshot !== false) {
    await page.screenshot({ path: path.join(outputDir, `${scenario.name}-final.png`), fullPage: true })
  }
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
    const mp4Path = path.join(outputDir, `${scenario.name}.mp4`)
    try {
      await convertToMp4(webmPath, mp4Path)
      report.mp4 = mp4Path
      report.video = mp4Path
    } catch (error) {
      console.warn(`[recorder] mp4 转码失败，保留 webm：${error.message}`)
      report.video = webmPath
    }
  } else {
    report.video = webmPath
  }

  if (scenario.outputs?.sidecarSubtitles && report.captions.length > 0) {
    await writeFile(path.join(outputDir, `${scenario.name}.vtt`), buildVtt(report.captions))
  }
  await writeFile(path.join(outputDir, `${scenario.name}-report.json`), JSON.stringify(report, null, 2))
  console.log(`[recorder] 已生成 report：${path.join(outputDir, scenario.name + "-report.json")}`)
  if (report.mp4) console.log(`[recorder] 已生成 MP4：${report.mp4}`)
  if (report.webm) console.log(`[recorder] 原始 WebM：${report.webm}`)
  await stopServer()
}
