import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { WebSocket } from "ws"
import { HelixPanes, parsePtyMessage } from "./helix.ts"

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

test("a pane asked for after the file closed never starts helix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-helix-"))
  const file = join(dir, "notes.md")
  writeFileSync(file, "# notes\n")
  const panes = new HelixPanes(file)
  panes.close()
  let closed = false
  const ws = {
    OPEN: 1,
    readyState: 1,
    close: () => (closed = true),
    on: () => {
      throw new Error("helix started")
    },
  }
  try {
    await panes.connect(ws as unknown as WebSocket, new URLSearchParams())
  } finally {
    rmSync(dir, { recursive: true })
  }
  expect(closed).toEqual(true)
})
