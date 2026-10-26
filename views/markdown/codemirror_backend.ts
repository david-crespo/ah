// The editor pane's backend when the editor runs in the page, as CodeMirror
// does (codemirror_pane.ts). The page gets the file's text from the doc
// socket and keeps the unsaved text itself, so this only saves. Each socket
// carries JSON text frames: saves from the page, and a reply to each.
//
// A save carries the text the page's edits started from, its base, and it
// goes through only if the file on disk is still that text. That way it
// never writes over a newer version, which may be the agent's edit. If the
// file has moved on, the reply carries what's on disk now, and the page
// merges its edits into that and saves again. Saves from every socket on the
// file go one at a time, so two pages can't both write over the same base.

import { readFile, writeFile } from "node:fs/promises"
import type { WebSocket } from "ws"
import type { EditorBackend } from "./editor.ts"

export type SaveRequest = { type: "save"; id: number; base: string; text: string }

export type SaveReply =
  | { type: "saved"; id: number }
  | { type: "stale"; id: number; text: string }
  | { type: "failed"; id: number; error: string }

/** A text frame from the page, or null if it isn't a save */
export function parseSave(text: string): SaveRequest | null {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof msg !== "object" || msg === null) return null
  const { type, id, base, text: saved } = msg as Record<string, unknown>
  return type === "save" &&
    Number.isInteger(id) &&
    typeof base === "string" &&
    typeof saved === "string"
    ? { type, id: Number(id), base, text: saved }
    : null
}

/** Saves for every page-side editor open on one file */
export class CodeMirrorBackend implements EditorBackend {
  readonly file: string
  #sockets = new Set<WebSocket>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  connect(ws: WebSocket) {
    this.#sockets.add(ws)
    ws.on("close", () => this.#sockets.delete(ws))
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? null : parseSave(String(data))
      if (!msg) return
      this.#queue = this.#queue.then(async () => {
        const reply = await this.save(msg)
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply))
      })
    })
  }

  /** Write `text` if the file is still `base` */
  async save({ id, base, text }: SaveRequest): Promise<SaveReply> {
    try {
      const disk = await readFile(this.file, "utf8")
      if (disk !== base) return { type: "stale", id, text: disk }
      await writeFile(this.file, text)
      return { type: "saved", id }
    } catch (e) {
      console.error(`ah: couldn't save ${this.file}:`, e)
      return { type: "failed", id, error: e instanceof Error ? e.message : String(e) }
    }
  }

  close() {
    for (const ws of this.#sockets) ws.close(1000, "file closed")
  }
}
