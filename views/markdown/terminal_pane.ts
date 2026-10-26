/// <reference lib="dom" />

// The editor pane when it's a terminal (editor.ts), page side: an xterm.js
// terminal wired to a terminal editor (terminal_editor.ts) running in a pty on
// the server (pty.ts). The editor starts on the pane's first show and keeps
// running while it's hidden, so toggling the pane doesn't lose editor state.

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { theme } from "../theme.ts"
import type { EditorPane } from "./editor.ts"
import type { TerminalEditor } from "./terminal_editor.ts"

/** Rex's cell for 13pt Berkeley Mono with its cell height at +6% (Settings,
 * Workspace.terminalCellHeightPercent), in CSS pixels: 16×33 at 2x */
const REX_CELL = { width: 8, height: 16.5 }

export class TerminalPane implements EditorPane {
  readonly #host: HTMLElement
  readonly #socketUrl: string
  readonly #editor: TerminalEditor
  #term: Terminal | null = null
  #sock: WebSocket | null = null
  /** Types keys into the editor, set once it has drawn: before that it may not
   * have the pty in raw mode yet. What needs it sooner waits in #waiters. */
  #type: ((keys: string) => void) | null = null
  #waiters: (() => void)[] = []
  /** When the editor last sent output, to tell when it's done drawing */
  #outputAt = 0

  constructor(host: HTMLElement, socketUrl: string, editor: TerminalEditor) {
    this.#host = host
    this.#socketUrl = socketUrl
    this.#editor = editor
  }

  show() {
    if (!this.#sock) this.#start()
    else this.#term?.focus()
  }

  /** The editor's goto, and then its lower to bring the cursor's line level
   * with `y`, staying a fifth of the text area from either edge, and at least
   * the editor's scrolloff */
  async reveal(line: number, column: number, y: number) {
    const type =
      this.#type ??
      (await new Promise<(keys: string) => void>((resolve) =>
        this.#waiters.push(() => resolve(this.#type!)),
      ))
    await this.#typeAndDraw(type, this.#editor.goto(line, column))
    const term = this.#term
    const screen = term?.element?.querySelector(".xterm-screen")?.getBoundingClientRect()
    if (!term || !screen?.height) return
    const cell = screen.height / term.rows
    const textRows = term.rows - this.#editor.statusRows
    const margin = Math.max(Math.round(textRows / 5), this.#editor.scrolloff)
    const level = Math.floor((y - screen.top) / cell)
    const row = Math.max(margin, Math.min(level, textRows - 1 - margin))
    const top = term.buffer.active.cursorY
    if (row > top) type(this.#editor.lower(row - top))
  }

  /** Type keys into the editor and wait until it has drawn what they did:
   * until its output has stopped for a moment, or a second has gone by */
  async #typeAndDraw(type: (keys: string) => void, keys: string) {
    const sentAt = performance.now()
    type(keys)
    while (performance.now() - sentAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (this.#outputAt > sentAt && performance.now() - this.#outputAt > 40) return
    }
  }

  #start() {
    const host = this.#host
    const editor = this.#editor
    const term = new Terminal({
      fontSize: theme.fontSize,
      fontFamily: theme.fontFamily,
      theme: { background: theme.background },
      cursorBlink: false,
      macOptionIsMeta: true,
    })
    this.#term = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // The default DOM renderer can't keep up with helix's full-viewport
    // redraws (holding k scrolled several times slower than in a terminal).
    // WebGL renders the same output at terminal speed; if the context is lost
    // or unavailable, dispose the addon and xterm falls back to the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn("ah: WebGL renderer unavailable, using DOM renderer", err)
    }
    matchRexCells(term)
    fitWhole(term, fit)
    // Reachable from the devtools console for debugging rendering issues
    Object.assign(globalThis, { ahTerm: term })

    const spawnSize = { cols: term.cols, rows: term.rows }
    const ws = new WebSocket(
      `${this.#socketUrl}?${new URLSearchParams({
        cols: String(spawnSize.cols),
        rows: String(spawnSize.rows),
      })}`,
    )
    ws.binaryType = "arraybuffer"
    this.#sock = ws
    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const sendSize = () => send({ type: "resize", cols: term.cols, rows: term.rows })
    // xterm doesn't encode ⌘, so the ⌘-chords the editor binds go to it as
    // whatever it takes them as. preventDefault keeps the browser from acting
    // on them too (⌘S would open Save Page). Other ⌘-chords go to the page (⌘E
    // toggles this pane) instead of xterm eating them.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.metaKey) return true
      const key = e.key.toLowerCase()
      const chord = Object.hasOwn(editor.chords, key) ? editor.chords[key] : undefined
      if (chord && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (e.type === "keydown") send({ type: "input", data: chord })
      }
      return false
    })
    ws.onopen = () => {
      // A fit that ran while the socket was still connecting had nowhere to
      // go; if the size moved on since spawn, tell the editor now.
      if (term.cols !== spawnSize.cols || term.rows !== spawnSize.rows) sendSize()
    }
    const type = (keys: string) => send({ type: "input", data: keys })
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return
      term.write(new Uint8Array(e.data))
      this.#outputAt = performance.now()
      if (this.#type !== type) {
        this.#type = type
        for (const wake of this.#waiters) wake()
        this.#waiters = []
      }
    }
    ws.onclose = () => {
      this.#sock = null
      if (this.#type === type) this.#type = null
      this.#term?.write(`\r\n\x1b[2m[${editor.name} exited — click here to restart]\x1b[0m`)
      host.addEventListener("click", () => this.#restart(), { once: true })
    }
    term.onData(type)
    // Spawn counts as a resize: switching to the alternate screen, which helix
    // does at startup, also fires xterm's scroll event.
    let lastResizeAt = Date.now()
    term.onResize(() => {
      lastResizeAt = Date.now()
      sendSize()
    })
    // Helix positions the cursor before every write and never wraps or line
    // feeds, so the alternate screen should never scroll. When it does, helix
    // and xterm disagree about the size (or a glyph width) and every row is
    // off by one until helix happens to rewrite it. Ask helix for a full
    // redraw, which it does on any resize event. Around a resize this is
    // expected and self-correcting: frames drawn for the old size land after
    // xterm shrank, and helix's redraw for the new size repairs them. Outside
    // that window it is an anomaly, so leave a trace in the console. Capped so
    // a persistent disagreement can't turn into a redraw loop.
    const redraws: number[] = []
    let redrawTimer: ReturnType<typeof setTimeout> | undefined
    term.onScroll(() => {
      if (this.#term !== term || term.buffer.active.type !== "alternate") return
      // xterm fires this before the resize event of the same resize() call, so
      // judge a moment later.
      setTimeout(() => {
        const now = Date.now()
        if (this.#term !== term || now - lastResizeAt < 1000) return
        while (redraws.length && now - redraws[0] > 10_000) redraws.shift()
        if (redraws.length >= 3) return
        console.warn(
          `ah: editor pane scrolled unexpectedly at ${term.cols}x${term.rows}; requesting redraw`,
        )
        clearTimeout(redrawTimer)
        redrawTimer = setTimeout(() => {
          redraws.push(Date.now())
          send({ type: "redraw" })
        }, 300)
      }, 50)
    })
    new ResizeObserver(() => {
      if (document.body.classList.contains("editor-shown")) fitWhole(term, fit)
    }).observe(host)
    term.focus()
  }

  #restart() {
    this.#term?.dispose()
    this.#term = null
    this.#start()
  }
}

/** Space xterm's cells out to Rex's. xterm floors the font's advance to
 * whole device pixels and uses its bare height, and what those come to
 * depends on the browser (Chrome's 15×30 at 2x, WebKit's bigger), so set
 * letterSpacing (added in device pixels) and lineHeight (multiplying the
 * height) from what it measured. That's in xterm's private render service,
 * so without it the cells stay as they are. */
function matchRexCells(term: Terminal) {
  const char = deviceSizes(term)?.char
  if (!char?.width || !char.height) return
  const dpr = window.devicePixelRatio
  term.options.letterSpacing = Math.round(REX_CELL.width * dpr) - char.width
  // xterm floors the product, so aim half a pixel over
  term.options.lineHeight = Math.max(
    1,
    (Math.round(REX_CELL.height * dpr) + 0.5) / char.height,
  )
}

type Size = { width: number; height: number }

/** The glyph and cell sizes xterm measured, in device pixels, from its
 * private render service */
function deviceSizes(term: Terminal) {
  type Core = {
    _renderService?: { dimensions?: { device?: { char?: Size; cell?: Size } } }
  }
  return (term as unknown as { _core?: Core })._core?._renderService?.dimensions?.device
}

/** FitAddon's fit, at a size whose canvas comes to whole CSS pixels. The
 * WebGL renderer sizes the canvas in device pixels and rounds its CSS size,
 * and WebKit has no devicePixelContentBoxSize to correct that with, so at 2x
 * an odd number of 33px rows stretches the canvas by a device pixel and one
 * pixel row of text shows doubled. At a ratio with no such size within a few
 * cells, it fits as FitAddon does. */
function fitWhole(term: Terminal, fit: FitAddon) {
  const dims = fit.proposeDimensions()
  const cell = deviceSizes(term)?.cell
  if (!dims || isNaN(dims.cols) || isNaN(dims.rows) || !cell?.width || !cell.height) {
    return fit.fit()
  }
  const dpr = window.devicePixelRatio
  const whole = (count: number, size: number) => {
    for (let n = count; n > Math.max(1, count - 4); n--) {
      const css = (n * size) / dpr
      if (Math.abs(css - Math.round(css)) < 1e-6) return n
    }
    return count
  }
  const cols = whole(dims.cols, cell.width)
  const rows = whole(dims.rows, cell.height)
  if (cols === term.cols && rows === term.rows) return
  // As FitAddon does, so the new size draws in full
  ;(
    term as unknown as { _core: { _renderService: { clear(): void } } }
  )._core._renderService.clear()
  term.resize(cols, rows)
}
