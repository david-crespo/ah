// The editor pane's backend when the pane is a terminal (editor.ts): a
// terminal editor (terminal_editor.ts) in a pty, one per socket, spawned when the page first shows the pane and hung up
// when the socket closes (page reload or close) or the file does. Output goes
// to the page as binary frames; input and resizes come back as JSON text
// frames.

import { dirname } from "node:path"
import { type IPty, spawn } from "@lydell/node-pty"
import type { WebSocket } from "ws"
import type { EditorBackend } from "./editor.ts"
import type { TerminalCommand } from "./terminal_editor.ts"

type PtyMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "redraw" }

/** A text frame from the page, or null if it isn't one we know: pty.write
 * and pty.resize throw on anything else, inside an event handler */
export function parsePtyMessage(text: string): PtyMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return null
  if (msg.type === "input") {
    return "data" in msg && typeof msg.data === "string"
      ? { type: "input", data: msg.data }
      : null
  }
  if (msg.type === "resize") {
    const size = (n: unknown) => (Number.isInteger(n) ? Number(n) : null)
    const cols = "cols" in msg ? size(msg.cols) : null
    const rows = "rows" in msg ? size(msg.rows) : null
    return cols !== null && rows !== null ? { type: "resize", cols, rows } : null
  }
  if (msg.type === "redraw") return { type: "redraw" }
  return null
}

/** Every terminal editor open on one file */
export class PtyBackend implements EditorBackend {
  readonly file: string
  readonly #command: TerminalCommand
  #ptys = new Set<IPty>()
  #closed = false

  constructor(file: string, command: TerminalCommand) {
    this.file = file
    this.#command = command
  }

  /** A pty socket: the editor at the page's terminal size, given in the query */
  async connect(ws: WebSocket, query: URLSearchParams) {
    let cols = Math.max(20, Number(query.get("cols")) || 80)
    let rows = Math.max(5, Number(query.get("rows")) || 24)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }
    let command: string
    let args: string[]
    try {
      ;({ command, args } = await this.#command(this.file))
    } catch (e) {
      console.error("ah: couldn't set up the editor:", e)
      return ws.close(1011, "couldn't start the editor")
    }
    // The page or the file may have gone while the command was set up, and
    // nothing would hang up an editor started now
    if (ws.readyState !== ws.OPEN || this.#closed) return ws.close()
    let pty: IPty
    try {
      pty = spawn(command, args, {
        cols,
        rows,
        cwd: dirname(this.file),
        env,
        encoding: null, // raw bytes, so a split UTF-8 sequence survives
      })
    } catch (e) {
      console.error(`ah: couldn't start ${command}:`, e)
      return ws.close(1011, "couldn't start the editor")
    }
    this.#ptys.add(pty)
    console.error(
      `ah: ${command} started for ${this.file} (pid ${pty.pid}, ${cols}x${rows})`,
    )

    pty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    })
    pty.onExit(({ exitCode }) => {
      this.#ptys.delete(pty)
      console.error(`ah: ${command} exited (${exitCode})`)
      if (ws.readyState === ws.OPEN) ws.close(1000, "editor exited")
    })
    ws.on("message", (data, isBinary) => {
      if (isBinary) return
      const msg = parsePtyMessage(String(data))
      if (msg?.type === "input") pty.write(msg.data)
      else if (msg?.type === "resize") {
        ;({ cols, rows } = msg)
        pty.resize(Math.max(20, cols), Math.max(5, rows))
      } else if (msg?.type === "redraw") {
        // A same-size resize raises no SIGWINCH, so send one: helix clears
        // and repaints everything on any resize event
        console.error(`ah: redraw requested by the page (${cols}x${rows})`)
        pty.kill("SIGWINCH")
      }
    })
    const hangup = () => {
      if (this.#ptys.has(pty)) pty.kill("SIGHUP")
    }
    ws.on("close", hangup)
    ws.on("error", hangup)
  }

  /** Hang up every pane, for closing the file */
  close() {
    this.#closed = true
    for (const pty of this.#ptys) pty.kill("SIGHUP")
  }
}
