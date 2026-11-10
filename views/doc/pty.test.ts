import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "vitest"
import type { WebSocket } from "ws"
import { PtyBackend, parsePtyMessage } from "./pty.ts"

test("parsePtyMessage takes only the messages the pane sends", () => {
  expect(parsePtyMessage('{"type":"input","data":"q"}')).toEqual({
    type: "input",
    data: "q",
  })
  expect(parsePtyMessage('{"type":"resize","cols":80,"rows":24}')).toEqual({
    type: "resize",
    cols: 80,
    rows: 24,
  })
  expect(parsePtyMessage('{"type":"redraw"}')).toEqual({ type: "redraw" })
  expect(parsePtyMessage('{"type":"input","data":5}')).toEqual(null)
  expect(parsePtyMessage('{"type":"resize","cols":"80","rows":24}')).toEqual(null)
  expect(parsePtyMessage("null")).toEqual(null)
  expect(parsePtyMessage("{")).toEqual(null)
})

test("a pane asked for after the file closed never starts the editor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-pty-"))
  const file = join(dir, "notes.md")
  writeFileSync(file, "# notes\n")
  const panes = new PtyBackend(file, async () => ({ command: "hx", args: [file] }))
  panes.close()
  let closed = false
  const ws = {
    OPEN: 1,
    readyState: 1,
    close: () => (closed = true),
    // The message listener is the only one attached before the editor starts
    on: (event: string) => {
      if (event !== "message") throw new Error("editor started")
    },
  }
  try {
    await panes.connect(ws as unknown as WebSocket, new URLSearchParams())
  } finally {
    rmSync(dir, { recursive: true })
  }
  expect(closed).toEqual(true)
})

/** A socket the backend can use, which keeps what it's sent */
class Socket extends EventEmitter {
  OPEN = 1
  readyState = 1
  output = ""
  closed = false
  send(data: Buffer) {
    this.output += data.toString()
  }
  // Left open, as while the close handshake is in flight
  close() {
    this.closed = true
  }
  message(msg: object) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false)
  }
}

test("a resize sent while the editor's command is set up is the size it starts at", async () => {
  const ws = new Socket()
  const panes = new PtyBackend("/tmp/x.md", async () => {
    await sleep(50)
    return { command: "/bin/sh", args: ["-c", "stty size"] }
  })
  const connecting = panes.connect(ws as never, new URLSearchParams("cols=80&rows=24"))
  ws.message({ type: "resize", cols: 120, rows: 40 })
  await connecting
  await expect.poll(() => ws.closed).toBe(true)
  expect(ws.output.trim()).toBe("40 120")
})

test("a message after the editor exits is dropped", async () => {
  const ws = new Socket()
  const panes = new PtyBackend("/tmp/x.md", async () => ({
    command: "/usr/bin/true",
    args: [],
  }))
  await panes.connect(ws as never, new URLSearchParams())
  await expect.poll(() => ws.closed).toBe(true)
  ws.message({ type: "resize", cols: 100, rows: 30 })
  ws.message({ type: "input", data: "x" })
  ws.message({ type: "redraw" })
})
