import { createRequire } from "node:module"
import path from "node:path"

export function loadWsConstructor(projectDirectory = process.cwd()) {
  try {
    const wsModule = createRequire(path.join(projectDirectory, "package.json"))("ws")
    return wsModule.WebSocket || wsModule.default || wsModule
  } catch (error) {
    throw new Error(`doubao-tts-v3 需要可设置 headers 的 ws 客户端。请在目标项目安装 ws：${error.message || error}`)
  }
}

export function createDoubaoQueue(ws, decode, deadline = Date.now() + 120_000) {
  const messages = []
  const waiters = []
  let closedError = null
  const fail = (error) => {
    closedError ||= error
    while (waiters.length) waiters.shift().reject(closedError)
  }
  ws.on("message", (data) => {
    if (closedError) return
    try {
      const value = decode(data)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(value)
      else messages.push(value)
    } catch (error) {
      fail(error)
    }
  })
  ws.on("error", fail)
  ws.on("close", (code, reason) => fail(new Error(`Doubao TTS WebSocket closed: ${code} ${reason || ""}`.trim())))
  return {
    next() {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return Promise.reject(new Error("Doubao TTS cue timed out"))
      if (messages.length) return Promise.resolve(messages.shift())
      if (closedError) return Promise.reject(closedError)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("Doubao TTS cue timed out")), remaining)
        waiters.push({
          resolve(value) { clearTimeout(timer); resolve(value) },
          reject(error) { clearTimeout(timer); reject(error) }
        })
      })
    }
  }
}

export function waitForWsOpen(ws, timeoutMs = 30_000) {
  if (ws.readyState === 1) return Promise.resolve()
  if (ws.readyState > 1) return Promise.reject(new Error("Doubao TTS WebSocket already closed"))
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      ws.off("open", onOpen)
      ws.off("error", onError)
      ws.off("close", onClose)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = () => finish()
    const onError = (error) => finish(error)
    const onClose = () => finish(new Error("Doubao TTS WebSocket closed before opening"))
    const timer = setTimeout(() => finish(new Error("Doubao TTS WebSocket opening timed out")), timeoutMs)
    ws.once("open", onOpen)
    ws.once("error", onError)
    ws.once("close", onClose)
  })
}
