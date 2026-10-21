import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDoubaoQueue, loadWsConstructor, waitForWsOpen } from "../lib/doubao-transport.mjs"

test("missing ws fails even when native WebSocket exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "doubao-no-ws-"))
  const original = globalThis.WebSocket
  globalThis.WebSocket = class { constructor() { throw new Error("native client must not be used") } }
  try {
    assert.throws(() => loadWsConstructor(directory), /请在目标项目安装 ws/)
  } finally {
    globalThis.WebSocket = original
    await rm(directory, { recursive: true, force: true })
  }
})

test("opening silence and early close reject and remove temporary listeners", async () => {
  for (const event of ["timeout", "close", "error", "open"]) {
    const ws = new EventEmitter()
    ws.readyState = 0
    const pending = waitForWsOpen(ws, 20)
    if (event === "open") {
      ws.emit("open")
      await pending
    } else {
      const rejected = assert.rejects(pending, /timed out|closed before|test error/)
      if (event === "error") ws.emit("error", new Error("test error"))
      if (event === "close") ws.emit("close", 1000)
      await rejected
    }
    assert.equal(ws.eventNames().length, 0)
  }
})

test("silent provider times out with every pending receiver settled", async () => {
  const ws = new EventEmitter()
  const queue = createDoubaoQueue(ws, value => value, Date.now() + 20)
  await Promise.all([assert.rejects(queue.next(), /timed out/), assert.rejects(queue.next(), /timed out/)])
  await assert.rejects(queue.next(), /timed out/)
})

test("cue deadline is absolute even with buffered messages", async () => {
  const ws = new EventEmitter()
  const queue = createDoubaoQueue(ws, value => value, Date.now() - 1)
  ws.emit("message", "keepalive")
  await assert.rejects(queue.next(), /timed out/)
})

test("buffered final messages survive close, then the queue rejects", async () => {
  const ws = new EventEmitter()
  const queue = createDoubaoQueue(ws, data => data.toString())
  ws.emit("message", Buffer.from("audio"))
  ws.emit("message", Buffer.from("finished"))
  ws.emit("close", 1000)
  assert.equal(await queue.next(), "audio")
  assert.equal(await queue.next(), "finished")
  await assert.rejects(queue.next(), /closed: 1000/)
})

test("decode errors and transport errors reject waiting receivers", async () => {
  for (const event of ["message", "error"]) {
    const ws = new EventEmitter()
    const queue = createDoubaoQueue(ws, () => { throw new Error("bad packet") })
    const rejected = assert.rejects(queue.next(), /bad packet|disconnected/)
    ws.emit(event, event === "message" ? Buffer.alloc(0) : new Error("disconnected"))
    await rejected
  }
})
