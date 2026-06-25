#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"

const DEFAULTS = {
  engine: "macos-say",
  language: "zh-CN",
  voice: null,
  rate: null,
  edgeRate: "+0%",
  edgePitch: "+0Hz",
  edgeVolume: "+0%",
  doubaoApiKey: null,
  doubaoEndpoint: "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
  doubaoResourceId: "seed-tts-2.0",
  doubaoModel: "seed-tts-2.0-expressive",
  doubaoSampleRate: 24000,
  doubaoBitRate: 128000,
  doubaoSpeechRate: 0,
  doubaoLoudnessRate: 20,
  timing: "auto",
  mix: "replace",
  originalVolume: 0.18,
  narrationVolume: 1,
  padMode: "freeze",
  padBufferMs: 300,
  maxPaddingMs: 60_000,
  videoCodec: "libx264",
  videoCrf: 20,
  videoPreset: "veryfast",
  scenario: null,
  keepTemp: false
}

// scenario.narration 中的字段 → 本脚本 args 字段
// 仅在用户没在 CLI 显式给同名参数时生效。这样 scaffold 沉淀到 scenario 的偏好
// （customer audience 默认 edge-tts + zh-CN-YunyangNeural 等）才能真正用上，
// 而不是要求用户每次手动重传 --engine/--voice。
const SCENARIO_NARRATION_FIELDS = [
  ["engine", "engine"],
  ["voice", "voice"],
  ["language", "language"],
  ["rate", "rate"],
  ["edgeRate", "edgeRate"],
  ["edgePitch", "edgePitch"],
  ["edgeVolume", "edgeVolume"],
  ["doubaoEndpoint", "doubaoEndpoint"],
  ["doubaoResourceId", "doubaoResourceId"],
  ["doubaoModel", "doubaoModel"],
  ["doubaoSampleRate", "doubaoSampleRate"],
  ["doubaoBitRate", "doubaoBitRate"],
  ["doubaoSpeechRate", "doubaoSpeechRate"],
  ["doubaoLoudnessRate", "doubaoLoudnessRate"],
  ["timing", "timing"],
  ["mix", "mix"],
  ["padMode", "padMode"],
  ["padBufferMs", "padBufferMs"],
  ["maxPaddingMs", "maxPaddingMs"],
  ["originalVolume", "originalVolume"],
  ["narrationVolume", "narrationVolume"]
]

const PAD_MODES = new Set(["freeze", "none"])

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/add-tts-narration.mjs --video <mp4> --report <report.json> --out <mp4> [options]

Required:
  --video <mp4|webm>      Source recording produced by the runner
  --report <report.json>  Recording report (provides captions[])
  --out <narrated.mp4>    Output narrated video. Sibling files
                          <out>-narration.vtt and <out>-narration-report.json
                          are written next to it.

Common options:
  --scenario <path>       Read defaults (engine/voice/rate/pad-mode/...) from
                          scenario.narration. Any CLI flag below overrides
                          the scenario value. RECOMMENDED so the engine
                          choice lives in one place (the scenario file).
  --engine <engine>       macos-say | local-system | edge-tts | doubao-tts-v3 (default: macos-say)
  --language <locale>     zh-CN | zh-TW | en-US (default: zh-CN)
  --voice <voice>         TTS voice name (engine-specific; see --help docs)
  --rate <wpm>            macOS say speech rate (default: 165 en-US, 180 zh-CN)
  --timing <mode>         auto | report | spread (default: auto)
  --mix <mode>            replace | duck | keep-original (default: replace)
  --pad-mode <mode>       freeze | none (default: freeze; auto-extends video
                          when a cue's TTS audio overruns its display window)
  --pad-buffer-ms <ms>    Buffer added after each cue (default: 300)
  --max-padding-ms <ms>   Fail-fast padding limit per cue (default: 60000)

edge-tts tuning:
  --edge-rate <value>     edge-tts rate, e.g. +0% / -10%
  --edge-pitch <value>    edge-tts pitch, e.g. +0Hz
  --edge-volume <value>   edge-tts volume, e.g. +0%

Doubao / Volcengine TTS v3 tuning:
  --doubao-api-key <key>        API key. Prefer env DOUBAO_TTS_API_KEY,
                                VOLCENGINE_TTS_API_KEY, or VOLCENGINE_API_KEY.
  --doubao-endpoint <wss-url>   WebSocket endpoint
                                (default: openspeech v3 bidirection)
  --doubao-resource-id <id>     Resource id (default: seed-tts-2.0)
  --doubao-model <model>        seed-tts-2.0-standard | seed-tts-2.0-expressive
  --doubao-sample-rate <hz>     Audio sample rate (default: 24000)
  --doubao-bit-rate <bps>       MP3 bit rate (default: 128000)
  --doubao-speech-rate <n>      -50..100 (default: 0)
  --doubao-loudness-rate <n>    -50..100 (default: 20)

Mixing volumes (only when --mix is duck/keep-original):
  --original-volume <n>   Original audio volume (default: 0.18)
  --narration-volume <n>  TTS narration volume (default: 1)

Re-encode tuning (only used when --pad-mode freeze triggers re-encoding):
  --video-codec <name>    Video codec (default: libx264)
  --video-crf <n>         CRF value, 0-51 (default: 20)
  --video-preset <name>   x264 preset (default: veryfast)

Debug:
  --keep-temp             Keep temporary synthesized audio files
  -h, --help              Show this help

Examples:
  # Use scenario.narration preferences (recommended after scaffold)
  node scripts/add-tts-narration.mjs \\
    --video docs/recordings/demo.mp4 \\
    --report docs/recordings/demo-report.json \\
    --out docs/recordings/demo-narrated.mp4 \\
    --scenario docs/recordings/demo.scenario.json

  # Force edge-tts with a specific voice
  node scripts/add-tts-narration.mjs \\
    --video docs/recordings/demo.mp4 \\
    --report docs/recordings/demo-report.json \\
    --out docs/recordings/demo-narrated.mp4 \\
    --engine edge-tts --voice zh-CN-YunyangNeural

  # Force Doubao / Volcengine TTS v3 (set key in env, not in scenario)
  DOUBAO_TTS_API_KEY=... node scripts/add-tts-narration.mjs \\
    --video docs/recordings/demo.mp4 \\
    --report docs/recordings/demo-report.json \\
    --out docs/recordings/demo-narrated.mp4 \\
    --engine doubao-tts-v3 --voice zh_female_jitangmei_uranus_bigtts
`)
    process.exit(0)
  }
  const args = { ...DEFAULTS }
  const provided = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === "--keep-temp") {
      args.keepTemp = true
      provided.add("keepTemp")
      continue
    }

    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }

    const camelKey = toCamelCase(key)
    // fail-fast on typos：DEFAULTS 没有该字段的话，说明是拼错的参数。
    // 之前不校验，--engin macos-say 会被静默赋给 args.engin，然后跑默认 engine。
    if (!(camelKey in args) && camelKey !== "video" && camelKey !== "report" && camelKey !== "out") {
      throw new Error(
        `无法识别参数：${token}。可用参数见 --help（包括 --video/--report/--out/--scenario/--engine/--voice/--rate/--language/--timing/--mix/--pad-mode/--pad-buffer-ms/--max-padding-ms/--video-codec/--video-crf/--video-preset/--original-volume/--narration-volume/--edge-rate/--edge-pitch/--edge-volume/--doubao-api-key/--keep-temp）。`
      )
    }
    args[camelKey] = value
    provided.add(camelKey)
    index += 1
  }

  if (!args.video) throw new Error("缺少 --video <mp4/webm>")
  if (!args.report) throw new Error("缺少 --report <report.json>")
  if (!args.out) throw new Error("缺少 --out <narrated.mp4>")

  // --scenario：把 scenario.narration 中的字段填充到 args，仅当用户没在 CLI 显式覆盖。
  // 这一步必须在 default-only 的字段（rate / voice）回退之前，否则 default 会先把 voice 选成 Tingting，
  // scenario.narration.voice="zh-CN-YunyangNeural" 反而被覆盖。
  if (args.scenario) {
    let scenarioJson = null
    try {
      scenarioJson = JSON.parse(readFileSync(args.scenario, "utf8"))
    } catch (error) {
      throw new Error(`--scenario 读取失败：${args.scenario}\n${error.message || error}`)
    }
    const narration = scenarioJson?.narration
    if (narration && typeof narration === "object") {
      for (const [argKey, scenarioKey] of SCENARIO_NARRATION_FIELDS) {
        if (provided.has(argKey)) continue
        const value = narration[scenarioKey]
        if (value === undefined || value === null) continue
        args[argKey] = value
      }
    }
  }

  args.rate = Number(args.rate || (args.language === "en-US" ? 165 : 180))
  args.originalVolume = Number(args.originalVolume)
  args.narrationVolume = Number(args.narrationVolume)
  args.padBufferMs = Number(args.padBufferMs)
  args.maxPaddingMs = Number(args.maxPaddingMs)
  args.videoCrf = Number(args.videoCrf)
  args.doubaoSampleRate = Number(args.doubaoSampleRate)
  args.doubaoBitRate = Number(args.doubaoBitRate)
  args.doubaoSpeechRate = Number(args.doubaoSpeechRate)
  args.doubaoLoudnessRate = Number(args.doubaoLoudnessRate)
  args.voice = args.voice || defaultVoice(args.language, args.engine)

  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error("--rate 必须是正数")
  }
  if (!Number.isFinite(args.padBufferMs) || args.padBufferMs < 0) {
    throw new Error("--pad-buffer-ms 必须是非负数")
  }
  if (!Number.isFinite(args.maxPaddingMs) || args.maxPaddingMs < 0) {
    throw new Error("--max-padding-ms 必须是非负数")
  }
  if (!PAD_MODES.has(args.padMode)) {
    throw new Error(`--pad-mode 仅支持 ${[...PAD_MODES].join("/")}，收到：${args.padMode}`)
  }
  // 历史上这里没校验 --video-crf；用户传 9999 会被 ffmpeg 拒绝得很不直观（"qp must be between 0 and 51"），
  // 而且只有走 padded filter 重编码时才会触发。提前 fail-fast 给个清晰错误。
  if (!Number.isFinite(args.videoCrf) || args.videoCrf < 0 || args.videoCrf > 51) {
    throw new Error("--video-crf 必须在 0-51 之间")
  }
  if (typeof args.videoPreset !== "string" || !args.videoPreset.trim()) {
    throw new Error("--video-preset 必须是 ffmpeg x264 preset 名（如 veryfast）")
  }
  if (typeof args.videoCodec !== "string" || !args.videoCodec.trim()) {
    throw new Error("--video-codec 必须是 ffmpeg 视频编码器名（如 libx264）")
  }
  if (args.engine === "doubao-tts" || args.engine === "doubao-tts-v3") {
    args.doubaoApiKey =
      args.doubaoApiKey ||
      process.env.DOUBAO_TTS_API_KEY ||
      process.env.VOLCENGINE_TTS_API_KEY ||
      process.env.VOLCENGINE_API_KEY
    if (!args.doubaoApiKey) {
      throw new Error(
        "使用 doubao-tts-v3 需要 --doubao-api-key，或设置 DOUBAO_TTS_API_KEY / VOLCENGINE_TTS_API_KEY"
      )
    }
    for (const key of ["doubaoSampleRate", "doubaoBitRate", "doubaoSpeechRate", "doubaoLoudnessRate"]) {
      if (!Number.isFinite(args[key])) throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} 必须是数字`)
    }
  }

  return args
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function defaultVoice(language, engine = "macos-say") {
  if (engine === "doubao-tts" || engine === "doubao-tts-v3") {
    return "zh_female_jitangmei_uranus_bigtts"
  }
  if (engine === "edge-tts") {
    if (language === "en-US") return "en-US-GuyNeural"
    if (language === "zh-TW") return "zh-TW-YunJheNeural"
    return "zh-CN-YunyangNeural"
  }
  if (language === "en-US") return "Samantha"
  if (language === "zh-TW") return "Meijia"
  return "Tingting"
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
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`))
      }
    })
  })
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  return result.status === 0
}

async function ffprobeJson(filePath, selectStreams) {
  const args = ["-v", "error", "-print_format", "json"]
  if (selectStreams) {
    args.push("-select_streams", selectStreams)
  }
  args.push("-show_streams", "-show_format", filePath)
  const { stdout } = await run("ffprobe", args)
  return JSON.parse(stdout)
}

async function probeDurationMs(filePath) {
  const probe = await ffprobeJson(filePath)
  const duration = Number(probe.format?.duration || 0)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法识别媒体时长：${filePath}`)
  }
  return Math.round(duration * 1000)
}

async function ffmpegVolumeDetect(filePath) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-"
  ])
  const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  const max = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null
  }
}

function formatVttTime(ms) {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = Math.floor(ms % 1000)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

function msToFfTime(ms) {
  return (ms / 1000).toFixed(3)
}

function normalizeNarrationText(caption) {
  if (caption?.narration === false) return null
  const text = caption?.narration || [caption?.title, caption?.body].filter(Boolean).join("。")
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/。。+/g, "。")
    .trim()
}

function buildCues(captions, videoDurationMs, timing) {
  const raw = captions
    .map((caption) => ({ caption, text: normalizeNarrationText(caption) }))
    .filter((item) => item.text)

  if (raw.length === 0) {
    throw new Error("report.captions 中没有可用于 TTS 的文案")
  }

  const hasReportTiming = raw.every(({ caption }) =>
    Number.isFinite(Number(caption.startMs)) || Number.isFinite(Number(caption.atMs))
  )
  const useReportTiming = timing === "report" || (timing === "auto" && hasReportTiming)
  const slotMs = videoDurationMs / raw.length

  const cues = raw.map(({ caption, text }, index) => {
    const requestedDuration = Number(caption.durationMs || caption.ms || 3600)
    let startMs
    let endMs

    if (useReportTiming) {
      startMs = Number(caption.startMs ?? caption.atMs ?? 0)
      endMs = Number(caption.endMs ?? startMs + requestedDuration)
    } else {
      startMs = Math.round(index * slotMs + Math.min(900, slotMs * 0.12))
      endMs = Math.round(Math.min(videoDurationMs - 250, (index + 1) * slotMs - 550))
      if (endMs <= startMs) {
        endMs = Math.min(videoDurationMs, startMs + requestedDuration)
      }
    }

    return {
      title: caption.title || "",
      body: caption.body || "",
      text,
      sourceStartMs: Math.max(0, Math.round(startMs)),
      sourceEndMs: Math.max(0, Math.round(endMs))
    }
  })

  cues.sort((a, b) => a.sourceStartMs - b.sourceStartMs)
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].sourceStartMs <= cues[i - 1].sourceStartMs) {
      throw new Error(
        `cue 时间轴错误：cue[${i}] startMs=${cues[i].sourceStartMs} 必须严格晚于 cue[${i - 1}] startMs=${cues[i - 1].sourceStartMs}`
      )
    }
  }

  return cues.map((cue, index) => ({ ...cue, index: index + 1 }))
}

function buildVtt(cues) {
  return `WEBVTT\n\n${cues
    .map(
      (cue) =>
        `${cue.index}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}`
    )
    .join("\n\n")}\n`
}

// 解析 `say -v "?"` 输出的 voice 列表，让我们在用户配置的 voice 不存在时能 fallback。
function listMacosVoices() {
  const result = spawnSync("say", ["-v", "?"], { encoding: "utf8" })
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      // 每行形如 "Tingting            zh_CN    # 你好！我叫婷婷。"
      const match = line.match(/^([^\s]+(?:\s\([^)]+\))?)\s+([a-zA-Z_-]+)/)
      if (!match) return null
      return { name: match[1].trim(), locale: match[2].trim() }
    })
    .filter(Boolean)
}

function pickMacosVoiceFallback(language, voices) {
  if (voices.length === 0) return null
  const localeMap = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", "en-US": "en_US" }
  const targetLocale = localeMap[language] || "zh_CN"
  const sameLocale = voices.find((voice) => voice.locale === targetLocale)
  if (sameLocale) return sameLocale.name
  return voices[0].name
}

async function synthesizeWithMacosSay(cues, args, tempDir) {
  if (!commandExists("say")) {
    throw new Error("当前系统没有 macOS say 命令，无法使用 local-system TTS")
  }

  const voices = listMacosVoices()
  const hasVoice = voices.some((voice) => voice.name === args.voice)
  if (!hasVoice && voices.length > 0) {
    const fallback = pickMacosVoiceFallback(args.language, voices)
    if (fallback) {
      console.warn(
        `[tts] macOS say 找不到 voice "${args.voice}"，自动 fallback 到 "${fallback}"。可用 voice 列表：${voices.slice(0, 8).map((voice) => voice.name).join(", ")}${voices.length > 8 ? " ..." : ""}`
      )
      args.voice = fallback
    } else {
      throw new Error(
        `macOS say 找不到 voice "${args.voice}"，且无法挑选 fallback。请运行 "say -v ?" 查看可用 voice，再用 --voice 指定。`
      )
    }
  }

  const files = []

  for (const cue of cues) {
    const textPath = path.join(tempDir, `cue-${String(cue.index).padStart(3, "0")}.txt`)
    const audioPath = path.join(tempDir, `cue-${String(cue.index).padStart(3, "0")}.aiff`)
    await writeFile(textPath, cue.text)
    await run("say", ["-v", args.voice, "-r", String(args.rate), "-f", textPath, "-o", audioPath])
    files.push(audioPath)
  }

  return files
}

async function synthesizeWithEdgeTts(cues, args, tempDir) {
  if (!commandExists("uvx")) {
    throw new Error("当前系统没有 uvx，无法使用 edge-tts。请安装 uv/uvx，或改用 --engine macos-say")
  }

  const files = []

  for (const cue of cues) {
    const stem = `cue-${String(cue.index).padStart(3, "0")}`
    const textPath = path.join(tempDir, `${stem}.txt`)
    const audioPath = path.join(tempDir, `${stem}.mp3`)
    await writeFile(textPath, cue.text)
    // edge-tts 走 Microsoft Edge online TTS，网络偶发抖动很常见。
    // 单段失败时做有限次重试，每次拉长间隔，避免长 demo 因为一次抖动整体失败。
    const maxAttempts = 3
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await run("uvx", [
          "edge-tts",
          "--voice",
          args.voice,
          "--rate",
          args.edgeRate,
          "--volume",
          args.edgeVolume,
          "--pitch",
          args.edgePitch,
          "--file",
          textPath,
          "--write-media",
          audioPath
        ])
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts) {
          const waitMs = 800 * attempt
          console.warn(
            `[tts] edge-tts cue ${cue.index} 第 ${attempt} 次失败，${waitMs}ms 后重试：${error.message?.split("\n")[0] || error}`
          )
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
      }
    }
    if (lastError) {
      throw new Error(
        `edge-tts cue ${cue.index} 在 ${maxAttempts} 次重试后仍然失败。请检查网络/uvx 是否可用，或改用 --engine macos-say。\n原始错误：${lastError.message || lastError}`
      )
    }
    files.push(audioPath)
  }

  return files
}

const DOUBAO_MSG_TYPE = {
  FullClientRequest: 0b1,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  Error: 0b1111
}

const DOUBAO_FLAG = {
  NoSeq: 0,
  PositiveSeq: 0b1,
  NegativeSeq: 0b11,
  WithEvent: 0b100
}

const DOUBAO_EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSSubtitle: 364
}

const DOUBAO_EVENT_NAME = new Map(Object.entries(DOUBAO_EVENT).map(([name, value]) => [value, name]))

function writeInt32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value, 0)
  return buffer
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

function writeString(value) {
  const bytes = Buffer.from(value || "", "utf8")
  return Buffer.concat([writeUInt32(bytes.length), bytes])
}

function shouldSkipSessionIdForEvent(event) {
  return [
    DOUBAO_EVENT.StartConnection,
    DOUBAO_EVENT.FinishConnection,
    DOUBAO_EVENT.ConnectionStarted,
    DOUBAO_EVENT.ConnectionFailed,
    DOUBAO_EVENT.ConnectionFinished
  ].includes(event)
}

function encodeDoubaoMessage({ type = DOUBAO_MSG_TYPE.FullClientRequest, flag = DOUBAO_FLAG.WithEvent, event, sessionId = "", payload = Buffer.from("{}") }) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const chunks = [
    Buffer.from([
      0x11, // version=1, header size=4 bytes
      (type << 4) | flag,
      0x10, // serialization=json, compression=none
      0x00
    ])
  ]

  if (flag === DOUBAO_FLAG.WithEvent) {
    chunks.push(writeInt32(event))
    if (!shouldSkipSessionIdForEvent(event)) {
      chunks.push(writeString(sessionId))
    }
  }

  chunks.push(writeUInt32(payloadBuffer.length), payloadBuffer)
  return Buffer.concat(chunks)
}

function decodeDoubaoMessage(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buffer.length < 4) throw new Error(`Doubao TTS response too short: ${buffer.length}`)
  const headerSize = (buffer[0] & 0x0f) * 4
  const type = buffer[1] >> 4
  const flag = buffer[1] & 0x0f
  let offset = headerSize

  const readInt32 = () => {
    const value = buffer.readInt32BE(offset)
    offset += 4
    return value
  }
  const readUInt32 = () => {
    const value = buffer.readUInt32BE(offset)
    offset += 4
    return value
  }
  const readString = () => {
    const size = readUInt32()
    const value = buffer.subarray(offset, offset + size).toString("utf8")
    offset += size
    return value
  }

  let sequence = 0
  let errorCode = 0
  if ([DOUBAO_MSG_TYPE.FullClientRequest, DOUBAO_MSG_TYPE.FullServerResponse, DOUBAO_MSG_TYPE.AudioOnlyServer].includes(type)) {
    if (flag === DOUBAO_FLAG.PositiveSeq || flag === DOUBAO_FLAG.NegativeSeq) {
      sequence = readInt32()
    }
  } else if (type === DOUBAO_MSG_TYPE.Error) {
    errorCode = readUInt32()
  }

  let event = 0
  let sessionId = ""
  let connectId = ""
  if (flag === DOUBAO_FLAG.WithEvent) {
    event = readInt32()
    if (!shouldSkipSessionIdForEvent(event)) {
      sessionId = readString()
    }
    if ([DOUBAO_EVENT.ConnectionStarted, DOUBAO_EVENT.ConnectionFailed, DOUBAO_EVENT.ConnectionFinished].includes(event)) {
      connectId = readString()
    }
  }

  const payloadSize = offset + 4 <= buffer.length ? readUInt32() : 0
  const payload = payloadSize > 0 ? buffer.subarray(offset, offset + payloadSize) : Buffer.alloc(0)
  return { type, flag, event, eventName: DOUBAO_EVENT_NAME.get(event) || `EventType(${event})`, sessionId, connectId, sequence, errorCode, payload }
}

function parseDoubaoPayloadJson(message) {
  if (!message.payload?.length) return null
  try {
    return JSON.parse(message.payload.toString("utf8"))
  } catch {
    return null
  }
}

function debugDoubaoMessage(prefix, message) {
  if (!process.env.REPO_DEMO_TTS_DEBUG) return
  const payload = parseDoubaoPayloadJson(message)
  const payloadSummary = payload
    ? JSON.stringify(payload).slice(0, 500)
    : message.payload?.length
      ? `<binary ${message.payload.length} bytes>`
      : "<empty>"
  console.error(
    `[doubao-debug] ${prefix} type=${message.type} flag=${message.flag} event=${message.eventName} payload=${payloadSummary}`
  )
}

function loadWsConstructor() {
  try {
    const projectRequire = createRequire(path.join(process.cwd(), "package.json"))
    const wsModule = projectRequire("ws")
    return wsModule.WebSocket || wsModule.default || wsModule
  } catch (error) {
    if (typeof WebSocket === "function") return WebSocket
    throw new Error(
      `doubao-tts-v3 需要可设置 headers 的 WebSocket 客户端。当前项目未能加载 ws 包：${error.message || error}`
    )
  }
}

function createDoubaoQueue(ws) {
  const queue = []
  const waiters = []
  let closedError = null

  const push = (value) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(value)
    else queue.push(value)
  }
  const fail = (error) => {
    closedError = error
    while (waiters.length > 0) waiters.shift().reject(error)
  }

  ws.on?.("message", (data) => {
    try {
      push(decodeDoubaoMessage(data))
    } catch (error) {
      fail(error)
    }
  })
  ws.on?.("error", fail)
  ws.on?.("close", (code, reason) => {
    if (!closedError) fail(new Error(`Doubao TTS WebSocket closed: ${code} ${reason || ""}`.trim()))
  })

  return {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      if (closedError) return Promise.reject(closedError)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    }
  }
}

function waitForWsOpen(ws) {
  if (ws.readyState === 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    ws.once?.("open", resolve)
    ws.once?.("error", reject)
  })
}

function sendDoubaoJson(ws, event, payload, sessionId = "") {
  const message = encodeDoubaoMessage({
    type: DOUBAO_MSG_TYPE.FullClientRequest,
    flag: DOUBAO_FLAG.WithEvent,
    event,
    sessionId,
    payload: Buffer.from(JSON.stringify(payload), "utf8")
  })
  ws.send(message)
}

async function receiveUntil(queue, predicate, context) {
  while (true) {
    const message = await queue.next()
    debugDoubaoMessage(context, message)
    if (message.type === DOUBAO_MSG_TYPE.Error || message.event === DOUBAO_EVENT.ConnectionFailed || message.event === DOUBAO_EVENT.SessionFailed) {
      const payload = parseDoubaoPayloadJson(message)
      throw new Error(
        `Doubao TTS ${context} failed at ${message.eventName}: ${JSON.stringify(payload || message.payload.toString("utf8"))}`
      )
    }
    if (predicate(message)) return message
  }
}

async function synthesizeOneDoubaoCue(cue, args, tempDir, WsConstructor) {
  const audioPath = path.join(tempDir, `cue-${String(cue.index).padStart(3, "0")}.mp3`)
  const connectId = randomUUID()
  const sessionId = randomUUID()
  const headers = {
    "X-Api-Key": args.doubaoApiKey,
    "X-Api-Resource-Id": args.doubaoResourceId,
    "X-Api-Connect-Id": connectId,
    "X-Control-Require-Usage-Tokens-Return": "*"
  }
  const ws = new WsConstructor(args.doubaoEndpoint, { headers })
  const queue = createDoubaoQueue(ws)

  try {
    await waitForWsOpen(ws)
    sendDoubaoJson(ws, DOUBAO_EVENT.StartConnection, {})
    await receiveUntil(
      queue,
      (message) => message.type === DOUBAO_MSG_TYPE.FullServerResponse && message.event === DOUBAO_EVENT.ConnectionStarted,
      "StartConnection"
    )

    sendDoubaoJson(
      ws,
      DOUBAO_EVENT.StartSession,
      {
        req_params: {
          model: args.doubaoModel,
          speaker: args.voice,
          audio_params: {
            format: "mp3",
            sample_rate: args.doubaoSampleRate,
            bit_rate: args.doubaoBitRate,
            speech_rate: args.doubaoSpeechRate,
            loudness_rate: args.doubaoLoudnessRate,
            enable_subtitle: false
          },
          additions: JSON.stringify({
            disable_markdown_filter: true,
            disable_emoji_filter: false,
            explicit_language: "zh-cn"
          }),
          aigc_watermark: false
        }
      },
      sessionId
    )
    await receiveUntil(
      queue,
      (message) => message.type === DOUBAO_MSG_TYPE.FullServerResponse && message.event === DOUBAO_EVENT.SessionStarted,
      "StartSession"
    )

    sendDoubaoJson(ws, DOUBAO_EVENT.TaskRequest, { req_params: { text: cue.text } }, sessionId)
    sendDoubaoJson(ws, DOUBAO_EVENT.FinishSession, {}, sessionId)

    const chunks = []
    while (true) {
      const message = await queue.next()
      debugDoubaoMessage(`cue ${cue.index}`, message)
      if (message.type === DOUBAO_MSG_TYPE.Error || message.event === DOUBAO_EVENT.SessionFailed) {
        const payload = parseDoubaoPayloadJson(message)
        throw new Error(
          `Doubao TTS cue ${cue.index} failed at ${message.eventName}: ${JSON.stringify(payload || message.payload.toString("utf8"))}`
        )
      }
      if (message.event === DOUBAO_EVENT.TTSResponse) {
        if (message.type === DOUBAO_MSG_TYPE.AudioOnlyServer) {
          chunks.push(message.payload)
        } else {
          const payload = parseDoubaoPayloadJson(message)
          const base64 = payload?.audio || payload?.data || payload?.payload
          if (base64) chunks.push(Buffer.from(base64, "base64"))
        }
      }
      if (message.event === DOUBAO_EVENT.SessionFinished) break
    }

    if (chunks.length === 0) {
      throw new Error(`Doubao TTS cue ${cue.index} 没有返回音频数据`)
    }
    await writeFile(audioPath, Buffer.concat(chunks))

    sendDoubaoJson(ws, DOUBAO_EVENT.FinishConnection, {})
    await receiveUntil(
      queue,
      (message) => message.type === DOUBAO_MSG_TYPE.FullServerResponse && message.event === DOUBAO_EVENT.ConnectionFinished,
      "FinishConnection"
    ).catch(() => null)
    ws.close?.()
    return audioPath
  } finally {
    if (ws.readyState === 1) ws.close?.()
  }
}

async function synthesizeWithDoubaoTts(cues, args, tempDir) {
  const WsConstructor = loadWsConstructor()
  const files = []
  for (const cue of cues) {
    const maxAttempts = 3
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        files.push(await synthesizeOneDoubaoCue(cue, args, tempDir, WsConstructor))
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts) {
          const waitMs = 900 * attempt
          console.warn(
            `[tts] doubao cue ${cue.index} 第 ${attempt} 次失败，${waitMs}ms 后重试：${error.message?.split("\n")[0] || error}`
          )
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
      }
    }
    if (lastError) {
      throw new Error(`doubao cue ${cue.index} 在 ${maxAttempts} 次重试后仍然失败：${lastError.message || lastError}`)
    }
  }
  return files
}

function applyPadding(cues, audioDurationsMs, videoDurationMs, args) {
  // window 锚点：每个 cue 的 sourceStartMs，以及视频结尾
  // 每个 cue 的展示窗口 = [cue.sourceStartMs, nextCue.sourceStartMs]（或 videoDurationMs）
  const adjusted = []
  let offset = 0

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]
    const audioMs = audioDurationsMs[i]
    const windowStartMs = cue.sourceStartMs
    const windowEndMs = i + 1 < cues.length ? cues[i + 1].sourceStartMs : videoDurationMs
    const windowMs = windowEndMs - windowStartMs

    if (windowMs <= 0) {
      throw new Error(`cue[${i}] 没有有效窗口：start=${windowStartMs}ms end=${windowEndMs}ms`)
    }

    let paddingMs = 0
    if (args.padMode === "freeze") {
      const neededMs = audioMs + args.padBufferMs
      paddingMs = Math.max(0, Math.round(neededMs - windowMs))
      if (paddingMs > args.maxPaddingMs) {
        throw new Error(
          `cue[${i}] 需要的 padding=${paddingMs}ms 超过 --max-padding-ms=${args.maxPaddingMs}ms。请缩短该段文案或调高上限。`
        )
      }
    }

    const sourceEndWithinWindowMs = Math.min(cue.sourceEndMs, windowEndMs)
    const preferredEndMs = Math.min(windowEndMs + paddingMs, cue.sourceStartMs + audioMs + args.padBufferMs)
    const adjustedEndMs = Math.min(
      videoDurationMs + offset + paddingMs,
      Math.max(sourceEndWithinWindowMs + offset, preferredEndMs + offset)
    )

    adjusted.push({
      ...cue,
      startMs: cue.sourceStartMs + offset,
      endMs: adjustedEndMs,
      sourceWindowStartMs: windowStartMs,
      sourceWindowEndMs: windowEndMs,
      windowEndMs: windowEndMs + offset + paddingMs,
      audioDurationMs: audioMs,
      paddingMs,
      durationMs: Math.max(250, adjustedEndMs - (cue.sourceStartMs + offset))
    })

    offset += paddingMs
  }

  return {
    cues: adjusted,
    totalPaddingMs: offset,
    totalDurationMs: videoDurationMs + offset
  }
}

const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"

function buildFastPathFilter(cues, hasOriginalAudio, args, silentInputIndex) {
  const parts = [`[${silentInputIndex}:a]${AUDIO_FORMAT},volume=0[silent]`]
  const mixInputs = ["[silent]"]

  if (hasOriginalAudio && args.mix !== "replace") {
    const originalVolume = args.mix === "duck" ? args.originalVolume : 1
    parts.push(`[0:a]${AUDIO_FORMAT},volume=${originalVolume}[base]`)
    mixInputs.push("[base]")
  }

  for (const [index, cue] of cues.entries()) {
    const inputIndex = index + 1
    const delay = Math.max(0, cue.startMs)
    const label = `n${index}`
    parts.push(
      `[${inputIndex}:a]${AUDIO_FORMAT},adelay=${delay}|${delay},volume=${args.narrationVolume}[${label}]`
    )
    mixInputs.push(`[${label}]`)
  }

  parts.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mix]`
  )
  return parts.join(";")
}

function buildPaddedFilter(cues, hasOriginalAudio, args, silentInputIndex, videoDurationMs) {
  const parts = []
  const videoSegments = []
  const audioSegments = []
  const splitsMs = cues.map((cue) => cue.sourceWindowStartMs)
  splitsMs.push(videoDurationMs)

  let cursor = 0
  let cueIdx = 0
  for (let i = 0; i < splitsMs.length; i += 1) {
    const segmentEnd = splitsMs[i]
    if (segmentEnd <= cursor) {
      continue
    }
    const segLabel = `v${i}`
    const trimEnd = segmentEnd >= videoDurationMs ? "" : `:end=${msToFfTime(segmentEnd)}`
    parts.push(`[0:v]trim=start=${msToFfTime(cursor)}${trimEnd},setpts=PTS-STARTPTS[${segLabel}]`)

    if (hasOriginalAudio && args.mix !== "replace") {
      const aLabel = `a${i}`
      parts.push(
        `[0:a]${AUDIO_FORMAT},atrim=start=${msToFfTime(cursor)}${trimEnd ? `:end=${msToFfTime(segmentEnd)}` : ""},asetpts=PTS-STARTPTS[${aLabel}]`
      )
      audioSegments.push({ label: aLabel, padMs: 0 })
    }

    // 这一段对应 cueIdx 的窗口（如果在 cue 序列里）；最后一段是收尾，没有 padding
    let segPadMs = 0
    if (cueIdx < cues.length && cues[cueIdx].sourceWindowStartMs === cursor) {
      segPadMs = cues[cueIdx].paddingMs
      cueIdx += 1
    }

    if (segPadMs > 0) {
      parts.push(
        `[${segLabel}]tpad=stop_mode=clone:stop_duration=${msToFfTime(segPadMs)}[${segLabel}p]`
      )
      videoSegments.push(`[${segLabel}p]`)
      if (audioSegments.length > 0) {
        const last = audioSegments[audioSegments.length - 1]
        last.padMs = segPadMs
      }
    } else {
      videoSegments.push(`[${segLabel}]`)
    }

    cursor = segmentEnd
  }

  parts.push(`${videoSegments.join("")}concat=n=${videoSegments.length}:v=1:a=0[outv]`)

  const mixInputs = []
  if (hasOriginalAudio && args.mix !== "replace") {
    const concatLabels = audioSegments.map((seg) => {
      if (seg.padMs > 0) {
        const padded = `${seg.label}p`
        parts.push(`[${seg.label}]apad=pad_dur=${msToFfTime(seg.padMs)}[${padded}]`)
        return `[${padded}]`
      }
      return `[${seg.label}]`
    })
    parts.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=0:a=1[orig]`)
    const ducked = args.mix === "duck" ? args.originalVolume : 1
    parts.push(`[orig]volume=${ducked}[base]`)
    mixInputs.push("[base]")
  } else {
    parts.push(`[${silentInputIndex}:a]${AUDIO_FORMAT},volume=0[silent]`)
    mixInputs.push("[silent]")
  }

  for (const [index, cue] of cues.entries()) {
    const inputIndex = index + 1
    const delay = Math.max(0, cue.startMs)
    const label = `n${index}`
    parts.push(
      `[${inputIndex}:a]${AUDIO_FORMAT},adelay=${delay}|${delay},volume=${args.narrationVolume}[${label}]`
    )
    mixInputs.push(`[${label}]`)
  }

  parts.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mix]`
  )
  return parts.join(";")
}

async function muxNarration({
  videoPath,
  audioFiles,
  cues,
  args,
  videoDurationMs,
  totalDurationMs,
  totalPaddingMs,
  hasOriginalAudio
}) {
  const totalSeconds = totalDurationMs / 1000
  const silentInputIndex = audioFiles.length + 1
  const ffmpegArgs = ["-y", "-i", videoPath]
  for (const audioFile of audioFiles) {
    ffmpegArgs.push("-i", audioFile)
  }
  ffmpegArgs.push(
    "-f",
    "lavfi",
    "-t",
    String(totalSeconds),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100"
  )

  const usePaddedFilter = totalPaddingMs > 0
  const filter = usePaddedFilter
    ? buildPaddedFilter(cues, hasOriginalAudio, args, silentInputIndex, videoDurationMs)
    : buildFastPathFilter(cues, hasOriginalAudio, args, silentInputIndex)

  ffmpegArgs.push("-filter_complex", filter)

  if (usePaddedFilter) {
    ffmpegArgs.push(
      "-map",
      "[outv]",
      "-map",
      "[mix]",
      "-c:v",
      args.videoCodec,
      "-crf",
      String(args.videoCrf),
      "-preset",
      args.videoPreset,
      "-pix_fmt",
      "yuv420p"
    )
  } else {
    ffmpegArgs.push("-map", "0:v:0", "-map", "[mix]", "-c:v", "copy")
  }

  ffmpegArgs.push("-c:a", "aac", "-b:a", "160k", "-t", String(totalSeconds), args.out)

  await run("ffmpeg", ffmpegArgs)
  return { usePaddedFilter }
}

const args = parseArgs(process.argv.slice(2))

if (!["macos-say", "local-system", "edge-tts", "doubao-tts", "doubao-tts-v3"].includes(args.engine)) {
  throw new Error(`当前脚本仅支持 macos-say/local-system/edge-tts/doubao-tts-v3，收到：${args.engine}`)
}
// 把生效的 engine/voice 打到 stdout，让用户能在一长串日志里一眼看到「这次到底用了什么 TTS」。
// 历史上这条信息只能从最终的 narration-report.json 里翻，遇到「scenario 里写了 edge-tts 但实际跑的是 macos-say」时不容易发现。
console.log(`[tts] engine=${args.engine} voice=${args.voice || "(auto)"} language=${args.language}${args.scenario ? ` scenario=${args.scenario}` : ""}`)
if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
  throw new Error("需要 ffmpeg 和 ffprobe")
}

const videoPath = path.resolve(args.video)
const reportPath = path.resolve(args.report)
const outputPath = path.resolve(args.out)
args.out = outputPath
await mkdir(path.dirname(outputPath), { recursive: true })

const report = JSON.parse(await readFile(reportPath, "utf8"))
const captions = Array.isArray(report.captions) ? report.captions : []
const videoProbe = await ffprobeJson(videoPath)
const audioProbe = await ffprobeJson(videoPath, "a").catch(() => ({ streams: [] }))
const videoDurationSeconds = Number(videoProbe.format?.duration || 0)
if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
  throw new Error("无法读取视频时长")
}
const videoDurationMs = Math.round(videoDurationSeconds * 1000)

const sourceCues = buildCues(captions, videoDurationMs, args.timing)
const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-tts-"))
const transcriptPath = outputPath.replace(/\.[^.]+$/, "-narration.vtt")
const reportOutPath = outputPath.replace(/\.[^.]+$/, "-narration-report.json")

try {
  const audioFiles =
    args.engine === "edge-tts"
      ? await synthesizeWithEdgeTts(sourceCues, args, tempDir)
      : args.engine === "doubao-tts" || args.engine === "doubao-tts-v3"
        ? await synthesizeWithDoubaoTts(sourceCues, args, tempDir)
      : await synthesizeWithMacosSay(sourceCues, args, tempDir)
  const audioDurationsMs = []
  for (const file of audioFiles) {
    audioDurationsMs.push(await probeDurationMs(file))
  }

  const { cues: adjustedCues, totalPaddingMs, totalDurationMs } = applyPadding(
    sourceCues,
    audioDurationsMs,
    videoDurationMs,
    args
  )
  const overflowingCues = adjustedCues.filter((cue) => cue.paddingMs > 0)

  await writeFile(transcriptPath, buildVtt(adjustedCues))

  const { usePaddedFilter } = await muxNarration({
    videoPath,
    audioFiles,
    cues: adjustedCues,
    args,
    videoDurationMs,
    totalDurationMs,
    totalPaddingMs,
    hasOriginalAudio: audioProbe.streams?.length > 0
  })

  const outputProbe = await ffprobeJson(outputPath, "a")
  if (!outputProbe.streams?.length) {
    throw new Error("输出视频没有音频流")
  }
  const outputFullProbe = await ffprobeJson(outputPath)
  const outputDurationSeconds = Number(outputFullProbe.format?.duration || 0)
  const outputDurationMs = Math.round(outputDurationSeconds * 1000)
  const expectedDurationMs = totalDurationMs
  const driftMs = Math.abs(outputDurationMs - expectedDurationMs)
  if (driftMs > Math.max(500, totalDurationMs * 0.02)) {
    throw new Error(
      `输出视频时长偏差过大：expected=${expectedDurationMs}ms actual=${outputDurationMs}ms drift=${driftMs}ms`
    )
  }
  const durationRatio = outputDurationSeconds / videoDurationSeconds
  const audioVolume = await ffmpegVolumeDetect(outputPath)
  if (audioVolume.maxVolumeDb == null || audioVolume.maxVolumeDb <= -50) {
    throw new Error(`输出音轨疑似静音：maxVolumeDb=${audioVolume.maxVolumeDb}`)
  }

  await writeFile(
    reportOutPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceVideo: videoPath,
        sourceReport: reportPath,
        outputVideo: outputPath,
        transcript: transcriptPath,
        engine: args.engine,
        language: args.language,
        voice: args.voice,
        rate: args.rate,
        timing: args.timing,
        mix: args.mix,
        padMode: args.padMode,
        padBufferMs: args.padBufferMs,
        usePaddedFilter,
        videoDurationSeconds,
        outputDurationSeconds,
        durationRatio,
        timeline: {
          sourceDurationMs: videoDurationMs,
          outputDurationMs,
          expectedDurationMs,
          totalPaddingMs,
          paddedCues: overflowingCues.length
        },
        media: {
          source: {
            durationSeconds: videoDurationSeconds,
            videoStreams: videoProbe.streams?.filter((stream) => stream.codec_type === "video") ?? [],
            audioStreams: audioProbe.streams ?? []
          },
          output: {
            durationSeconds: outputDurationSeconds,
            videoStreams: outputFullProbe.streams?.filter((stream) => stream.codec_type === "video") ?? [],
            audioStreams: outputProbe.streams ?? [],
            audioVolume
          }
        },
        cues: adjustedCues
      },
      null,
      2
    )}\n`
  )

  console.log(`已生成带解说视频：${outputPath}`)
  console.log(`已生成解说字幕：${transcriptPath}`)
  console.log(`已生成解说报告：${reportOutPath}`)
  if (overflowingCues.length > 0) {
    console.log(
      `已为 ${overflowingCues.length} 段超时 TTS 自动延长视频，总增加时长：${totalPaddingMs}ms`
    )
    for (const cue of overflowingCues) {
      console.log(
        `  - cue ${cue.index} "${cue.title || cue.text.slice(0, 20)}" padding=${cue.paddingMs}ms (audio=${cue.audioDurationMs}ms, window=${cue.sourceWindowEndMs - cue.sourceWindowStartMs}ms)`
      )
    }
  }
} finally {
  if (!args.keepTemp) {
    await rm(tempDir, { recursive: true, force: true })
  } else {
    console.log(`保留临时目录：${tempDir}`)
  }
}
