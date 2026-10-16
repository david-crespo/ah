// The file page's helix pane: real hx in a pty, one per pty socket, spawned
// when the page first shows the pane and hung up when the socket closes
// (page reload or close) or the file does. Output goes to the page as binary
// frames; input and resizes come back as JSON text frames.

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type IPty, spawn } from "@lydell/node-pty"
import type { WebSocket } from "ws"

// Helix gets a temp config: the user's config.toml (if any) plus auto-save, so
// the preview updates shortly after typing stops, and auto-reload, so the pane
// picks up the agent's edits to the file instead of going stale. `hx --config`
// replaces config.toml entirely, which is why this concatenates rather than
// overrides. Steel config (init.scm) still loads from the normal location.
//
// auto-reload is not upstream helix: it's the `auto-reload` branch of the
// user's fork (a port of helix-editor/helix#13963 that reloads unmodified
// buffers silently). With `merge`, buffers with unsaved edits get a three-way
// merge of disk into the buffer; overlapping edits are left as conflict
// markers to resolve in place. Upstream helix rejects the unknown section.
const AUTO_SAVE = `
[editor.auto-save]
focus-lost = true

[editor.auto-save.after-delay]
enable = true
timeout = 650
`

const AUTO_RELOAD = `
[editor.auto-reload]
focus-gained = true
merge = true

[editor.auto-reload.periodic]
enable = true
interval = 300
`

let config: Promise<string> | null = null

/** Written once per server, on the first pane; tried again on the next pane
 * if it failed */
function helixConfig(): Promise<string> {
  if (!config) {
    config = (async () => {
      let text = ""
      try {
        text = await readFile(join(homedir(), ".config/helix/config.toml"), "utf8")
      } catch {
        // no user config; the added sections alone are fine
      }
      if (!text.includes("[editor.auto-save")) text += AUTO_SAVE
      if (!text.includes("[editor.auto-reload")) text += AUTO_RELOAD
      const path = join(await mkdtemp(join(tmpdir(), "ah-hx-")), "config.toml")
      await writeFile(path, text)
      return path
    })()
    config.catch(() => (config = null))
  }
  return config
}

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

/** Every helix open on one file */
export class HelixPanes {
  readonly file: string
  #ptys = new Set<IPty>()
  #closed = false

  constructor(file: string) {
    this.file = file
  }

  /** A pty socket: helix at the page's terminal size, given in the query */
  async connect(ws: WebSocket, query: URLSearchParams) {
    let cols = Math.max(20, Number(query.get("cols")) || 80)
    let rows = Math.max(5, Number(query.get("rows")) || 24)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }
    let config: string
    try {
      config = await helixConfig()
    } catch (e) {
      console.error("ah: couldn't write helix's config:", e)
      return ws.close(1011, "couldn't start helix")
    }
    // The page or the file may have gone while the config was written, and
    // nothing would hang up a helix started now
    if (ws.readyState !== ws.OPEN || this.#closed) return ws.close()
    let pty: IPty
    try {
      pty = spawn("hx", ["--config", config, this.file], {
        cols,
        rows,
        cwd: dirname(this.file),
        env,
        encoding: null, // raw bytes, so a split UTF-8 sequence survives
      })
    } catch (e) {
      console.error("ah: couldn't start helix:", e)
      return ws.close(1011, "couldn't start helix")
    }
    this.#ptys.add(pty)
    console.error(`ah: helix started for ${this.file} (pid ${pty.pid}, ${cols}x${rows})`)

    pty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    })
    pty.onExit(({ exitCode }) => {
      this.#ptys.delete(pty)
      console.error(`ah: helix exited (${exitCode})`)
      if (ws.readyState === ws.OPEN) ws.close(1000, "helix exited")
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
