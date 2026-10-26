/// <reference lib="dom" />

// Browser half of ah's markdown file page, served as /view/markdown/bundle.js
// (see platform/bundle.ts). The preview itself is the <ah-markdown>
// element (preview.ts); this adds what only the file page has: real helix in
// a collapsible xterm.js pane wired to pty, the thread's conversation and
// selection comment popover (views/thread/), and ⌘F's find bar (find.ts).
// The page leaves out the editor pane with ?editor=off and the chat with
// ?chat=off.

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Conversation } from "../thread/conversation.ts"
import { threadKinds } from "../../subjects/thread/kinds.ts"
import { setUpSelectionComments } from "../thread/selection.ts"
import { setUpFind } from "./find.ts"
import { theme } from "../theme.ts"
import "./preview.ts"
import { type SourcePosition, sourcePosition } from "./source_position.ts"

const preview = document.querySelector("ah-markdown")!
const content = preview.content
const editorHost = document.getElementById("editor-host")
const editorToggle = document.getElementById("editor-toggle")
// Selection comments go through the conversation, so both are only there
// with chat on
const chat = document.getElementById("popover") !== null
let hidePopover = () => {}
const conversation = chat ? new Conversation(() => hidePopover(), threadKinds) : null
if (conversation) hidePopover = setUpSelectionComments(content, conversation)
setUpFind(content)

/** A WebSocket URL relative to the file's page */
function wsUrl(path: string): string {
  const url = new URL(path, location.href)
  url.protocol = "ws:"
  return url.href
}

// The doc socket also carries the thread
preview.addEventListener("doc-message", (e) => {
  const msg = e.detail
  if (msg.type === "thread") conversation?.receive(msg, msg.replay)
})
preview.addEventListener("doc-close", () => conversation?.setConnected(false))
// ranges are stale after re-render
preview.addEventListener("render", () => CSS.highlights.delete("pending-comment"))

// Browsers only let a script close windows that a script opened, or ones
// with a single history entry, so this may do nothing; the preview says it's
// closed either way.
preview.addEventListener("closed", () => {
  window.close()
  document.title = `${document.title} (closed)`
})

// ---------- helix pane ----------

// Real helix runs server-side in a pty (see helix.ts); this pane is
// its terminal. The pane always starts collapsed, and helix starts on first
// show and keeps running while hidden, so toggling the pane doesn't lose
// editor state.
let term: Terminal | null = null
let ptySock: WebSocket | null = null
/** Types keys into helix, set once it has drawn: before that it may not have
 * the pty in raw mode yet. What needs it sooner waits in helixWaiters. */
let typeIntoHelix: ((keys: string) => void) | null = null
let helixWaiters: (() => void)[] = []
/** When helix last sent output, to tell when it's done drawing */
let helixOutputAt = 0
/** ⌘-chords the user's helix config binds: write, and extend the selection
 * by a line up or down */
const HELIX_CMD_KEYS = new Set(["s", "j", "k"])

/** Rex's cell for 13pt Berkeley Mono with its cell height at +6% (Settings,
 * Workspace.terminalCellHeightPercent), in CSS pixels: 16×33 at 2x */
const REX_CELL = { width: 8, height: 16.5 }

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

function startHelix(host: HTMLElement) {
  term = new Terminal({
    fontSize: theme.fontSize,
    fontFamily: theme.fontFamily,
    theme: { background: theme.background },
    cursorBlink: false,
    macOptionIsMeta: true,
  })
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
    wsUrl(
      `pty?${new URLSearchParams({
        cols: String(spawnSize.cols),
        rows: String(spawnSize.rows),
      })}`,
    ),
  )
  ws.binaryType = "arraybuffer"
  ptySock = ws
  const send = (msg: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }
  const sendSize = () => send({ type: "resize", cols: term!.cols, rows: term!.rows })
  // xterm doesn't encode ⌘, so the ⌘-chords helix binds go to it as kitty
  // keyboard protocol super chords (CSI codepoint;9u), which helix parses
  // without negotiating the protocol. preventDefault keeps the browser from
  // acting on them too (⌘S would open Save Page). Other ⌘-chords go to the
  // page (⌘E toggles this pane) instead of xterm eating them.
  term.attachCustomKeyEventHandler((e) => {
    if (!e.metaKey) return true
    const key = e.key.toLowerCase()
    if (HELIX_CMD_KEYS.has(key) && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      if (e.type === "keydown")
        send({ type: "input", data: `\x1b[${key.codePointAt(0)};9u` })
    }
    return false
  })
  ws.onopen = () => {
    // A fit that ran while the socket was still connecting had nowhere to
    // go; if the size moved on since spawn, tell helix now.
    if (term!.cols !== spawnSize.cols || term!.rows !== spawnSize.rows) sendSize()
  }
  const type = (keys: string) => send({ type: "input", data: keys })
  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return
    term?.write(new Uint8Array(e.data))
    helixOutputAt = performance.now()
    if (typeIntoHelix !== type) {
      typeIntoHelix = type
      for (const wake of helixWaiters) wake()
      helixWaiters = []
    }
  }
  ws.onclose = () => {
    ptySock = null
    if (typeIntoHelix === type) typeIntoHelix = null
    term?.write("\r\n\x1b[2m[helix exited — click here to restart]\x1b[0m")
    host.addEventListener("click", () => restartHelix(host), { once: true })
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
    if (!term || term.buffer.active.type !== "alternate") return
    // xterm fires this before the resize event of the same resize() call, so
    // judge a moment later.
    setTimeout(() => {
      const now = Date.now()
      if (!term || now - lastResizeAt < 1000) return
      while (redraws.length && now - redraws[0] > 10_000) redraws.shift()
      if (redraws.length >= 3) return
      console.warn(
        `ah: helix pane scrolled unexpectedly at ${term.cols}x${term.rows}; requesting redraw`,
      )
      clearTimeout(redrawTimer)
      redrawTimer = setTimeout(() => {
        redraws.push(Date.now())
        send({ type: "redraw" })
      }, 300)
    }, 50)
  })
  // This terminal, not whichever one a restart has put in term since
  const started = term
  new ResizeObserver(() => {
    if (document.body.classList.contains("editor-shown")) fitWhole(started, fit)
  }).observe(host)
  term.focus()
}

function restartHelix(host: HTMLElement) {
  term?.dispose()
  term = null
  startHelix(host)
}

function setEditorShown(shown: boolean) {
  if (!editorHost) return
  document.body.classList.toggle("editor-shown", shown)
  if (!shown) return
  if (!ptySock) startHelix(editorHost)
  else term?.focus()
}

if (editorHost && editorToggle) {
  editorToggle.addEventListener("click", () => {
    setEditorShown(!document.body.classList.contains("editor-shown"))
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "e" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      setEditorShown(!document.body.classList.contains("editor-shown"))
    }
  })
  content.addEventListener("click", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const target = e.target as Element
    // ⌘-click on a link still opens it
    if (target.closest("a")) return
    const block = target.closest<HTMLElement>("[data-line]")
    const text = preview.text
    if (!block || !content.contains(block) || text === null) return
    e.preventDefault()
    const [start, end] = block.dataset.line!.split(":").map(Number)
    let caret = caretAt(e.clientX, e.clientY)
    if (caret && !block.contains(caret.node)) caret = null
    let before = ""
    const spot = document.createRange()
    if (caret) {
      const upTo = document.createRange()
      upTo.setStart(block, 0)
      upTo.setEnd(caret.node, caret.offset)
      before = upTo.toString()
      spot.setStart(caret.node, caret.offset)
      // The character after the caret, since a collapsed range may have no
      // box to measure
      if (caret.node instanceof Text && caret.offset < caret.node.length)
        spot.setEnd(caret.node, caret.offset + 1)
    } else spot.selectNodeContents(block)
    void showInHelix(sourcePosition(text.split("\n"), start, end, before), spot)
  })
}

/** The caret position at (x, y) */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(x, y)
    return caret && { node: caret.offsetNode, offset: caret.offset }
  }
  // WebKit before Safari 26 has only the older one
  const range = document.caretRangeFromPoint(x, y)
  return range && { node: range.startContainer, offset: range.startOffset }
}

/** The middle of the first line `range` is on, in client coordinates */
function middleOf(range: Range): number {
  const box = range.getClientRects()[0] ?? range.getBoundingClientRect()
  return box.top + box.height / 2
}

/** Type keys into helix and wait until it has drawn what they did: until its
 * output has stopped for a moment, or a second has gone by */
async function typeAndDraw(type: (keys: string) => void, keys: string) {
  const sentAt = performance.now()
  type(keys)
  while (performance.now() - sentAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (helixOutputAt > sentAt && performance.now() - helixOutputAt > 40) return
  }
}

/** Show the editor with helix's cursor at `line` and `column`, as near as it
 * goes to the row level with `spot`, the place in the preview it came from.
 * The preview stays put, since that's where the user clicked.
 *
 * Escape, to get to normal mode from insert mode, a prompt or a picker, goes
 * as a kitty keyboard protocol key (CSI 27u), which helix parses without
 * negotiating it: a bare ESC with more keys after it in one read is Alt plus
 * the next key. Then `:goto`, a count of `l` for the column, and `zt`, which
 * leaves the cursor `scrolloff` rows from the top (or lower near the file's
 * start, where the view can't scroll up). Each k in sticky view mode (Z)
 * scrolls the view up a row and so moves the cursor down one, which it can
 * do until it's `scrolloff` rows from the bottom of the text area, above the
 * status and command lines. It stays a fifth of the text area from either
 * edge, and at least helix's default scrolloff of 5 (a bigger one would move
 * it off its line near the bottom). */
async function showInHelix({ line, column }: SourcePosition, spot: Range) {
  const shown = document.body.classList.contains("editor-shown")
  const y = middleOf(spot)
  setEditorShown(true)
  // The preview narrows and reflows; keep the spot where it was clicked
  if (!shown) window.scrollBy(0, middleOf(spot) - y)
  const type =
    typeIntoHelix ??
    (await new Promise<(keys: string) => void>((resolve) =>
      helixWaiters.push(() => resolve(typeIntoHelix!)),
    ))
  await typeAndDraw(type, `\x1b[27u:goto ${line + 1}\r${column ? `${column}l` : ""}zt`)
  const shownTerm = term
  const screen = shownTerm?.element?.querySelector(".xterm-screen")?.getBoundingClientRect()
  if (!shownTerm || !screen?.height) return
  const cell = screen.height / shownTerm.rows
  const textRows = shownTerm.rows - 2
  const margin = Math.max(Math.round(textRows / 5), 5)
  const level = Math.floor((middleOf(spot) - screen.top) / cell)
  const row = Math.max(margin, Math.min(level, textRows - 1 - margin))
  const top = shownTerm.buffer.active.cursorY
  if (row > top) type(`Z${"k".repeat(row - top)}\x1b[27u`)
}

// ? shows the page's shortcuts (page.ts), unless it's being typed somewhere:
// the comment and chat boxes, or helix, whose xterm takes keys in a textarea
const shortcuts = document.getElementById("shortcuts") as HTMLDialogElement
document.addEventListener("keydown", (e) => {
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement
  if (target.closest("input, textarea, select, [contenteditable]")) return
  e.preventDefault()
  if (shortcuts.open) shortcuts.close()
  else shortcuts.showModal()
})

// ⇧⌘C copies the file's path, from anywhere on the page: the editor pane
// passes it on with the other ⌘-chords helix doesn't bind. (Not VS Code's
// ⌥⌘C, which Alfred takes for its clipboard.) In a Chrome tab, DevTools'
// element picker may get it first.
const copied = document.getElementById("copied")!
let copiedTimer = 0
async function copyPath() {
  const path = document.body.dataset.path ?? ""
  try {
    await navigator.clipboard.writeText(path)
    copied.textContent = `Copied ${path}`
  } catch {
    copied.textContent = "Couldn't copy the path"
  }
  copied.classList.add("shown")
  clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => copied.classList.remove("shown"), 1500)
}
document.addEventListener("keydown", (e) => {
  if (e.code === "KeyC" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    void copyPath()
  }
})
