/// <reference lib="dom" />

// Browser half of ah's markdown file page, served as /app/markdown/bundle.js
// (see host/bundle.ts). The preview itself is the <ah-markdown>
// element (preview.ts); this adds what only the file page has: real helix in
// a collapsible xterm.js pane wired to pty, and the thread's conversation
// and selection comment popover (host/chat/). The page leaves out the editor
// pane with ?editor=off and the chat with ?chat=off.

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Conversation } from "../../host/chat/conversation.ts"
import { setUpSelectionComments } from "../../host/chat/selection.ts"
import { theme } from "../../host/theme.ts"
import "./preview.ts"

const preview = document.querySelector("ah-markdown")!
const content = preview.content
const editorHost = document.getElementById("editor-host")
const editorToggle = document.getElementById("editor-toggle")
// Selection comments go through the conversation, so both are only there
// with chat on
const chat = document.getElementById("popover") !== null
let hidePopover = () => {}
const conversation = chat ? new Conversation(() => hidePopover()) : null
if (conversation) hidePopover = setUpSelectionComments(content, conversation)

/** A WebSocket URL relative to the file's page */
function wsUrl(path: string): string {
  const url = new URL(path, location.href)
  url.protocol = "ws:"
  return url.href
}

// The doc socket also carries the conversation
preview.addEventListener("doc-message", (e) => {
  const msg = e.detail
  if (msg.type === "conversation") conversation?.receive(msg, msg.replay)
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

function startHelix(host: HTMLElement) {
  term = new Terminal({
    fontSize: theme.fontSize,
    fontFamily: theme.fontFamily,
    // xterm floors the 0.6em advance to whole device pixels and uses the
    // font's bare height, so 13px Berkeley Mono gets 15×30 cells at 2x where
    // Ghostty (with adjust-cell-height = 2) gives 16×33. letterSpacing is
    // added in device pixels; lineHeight multiplies the height.
    letterSpacing: 1,
    lineHeight: 1.1,
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
  fit.fit()
  // Reachable from the devtools console for debugging rendering issues
  Object.assign(globalThis, { ahTerm: term })
  // Let ⌘-chords through to the page (⌘E toggles this pane, ⌘S is swallowed
  // below) instead of xterm eating them.
  term.attachCustomKeyEventHandler((e) => !e.metaKey)

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
  ws.onopen = () => {
    // A fit that ran while the socket was still connecting had nowhere to
    // go; if the size moved on since spawn, tell helix now.
    if (term!.cols !== spawnSize.cols || term!.rows !== spawnSize.rows) sendSize()
  }
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) term?.write(new Uint8Array(e.data))
  }
  ws.onclose = () => {
    ptySock = null
    term?.write("\r\n\x1b[2m[helix exited — click here to restart]\x1b[0m")
    host.addEventListener("click", () => restartHelix(host), { once: true })
  }
  term.onData((data) => send({ type: "input", data }))
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
  new ResizeObserver(() => {
    if (document.body.classList.contains("editor-shown")) fit.fit()
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

  // Helix auto-saves, so ⌘S has nothing to do; consume the reflexive macOS
  // save shortcut before the browser opens its Save Page UI.
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "s" &&
        event.target instanceof Node &&
        editorHost.contains(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    { capture: true },
  )
}
