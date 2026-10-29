/// <reference lib="dom" />

// Browser half of the dashboard, served as /view/dashboard/client.js to
// page.html. It follows the server's event stream (routes.ts): the Rex
// tabs in jj workspaces and which is focused, each workspace's jj log, and
// each workspace's trackers, and each tab's file (its workspace's current
// tracker), shown with <ah-markdown> from
// ../markdown/preview.js, or an html file in a frame of its page on the html
// pages port.

import type { State } from "./workspace.ts"

const byId = (id: string) => document.getElementById(id)!
const strip = byId("strip")
const logPane = byId("log-pane")
const docPane = byId("doc-pane")
const docName = byId("doc-name")
const trackerStrip = byId("trackers")
const parkedMenu = byId("parked")
const status = byId("status")

let version: string | null = null
let state: State = { focused: null, tabs: [] }
// Not workspace.ts's: importing a value from there would bundle node:fs
const focusedRoot = () => state.tabs.find((t) => t.id === state.focused)?.root ?? null
const logs = new Map<string, string>() // root -> html
const scrollTops = new Map<string, number>() // root -> scroll position, kept across tab switches
let shown: { root: string | null; html: string | null } = { root: null, html: null }
// tab -> { path, view }, each view an <ah-markdown> (from
// ../markdown/preview.js) or an <iframe> that stays in the pane while its
// tab has the file, hidden unless focused, so a tab switch keeps its
// scroll and doesn't reconnect
const docs = new Map<string, { path: string; view: HTMLElement }>()
const docScrollTops = new Map<string, number>()
let shownDoc: string | null = null // tab
// root -> its current tracker, and the active and parked ones, most recent first
const trackers = new Map<
  string,
  { current: string | null; active: string[]; parked: string[] }
>()

/** A tracker's name: its directory's for an index.html, without the date
 * and the -tracker suffix */
function trackerName(path: string): string {
  const parts = path.split("/")
  const name = (parts.at(-1) === "index.html" ? parts.at(-2) : parts.at(-1)) ?? path
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-tracker$/, "")
}

function el(tag: string, attrs: Partial<HTMLElement>, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  Object.assign(e, attrs)
  e.append(...children)
  return e
}

function render() {
  const { focused, tabs } = state
  strip.replaceChildren(
    ...tabs.map((t) =>
      el(
        "span",
        {
          className: "chip" + (t.id === focused ? " focused" : ""),
          title: t.title,
          onclick: () => void focus(t.id),
        },
        t.name,
      ),
    ),
  )

  const w = tabs.find((t) => t.id === focused)
  renderDoc(w?.id ?? null)
  if (!w) {
    logPane.replaceChildren(
      el("p", { className: "empty" }, "No jj workspace in the focused tab."),
    )
    shown = { root: null, html: null }
    return
  }
  document.title = w.name

  // Only touch the DOM when the content changed, so scroll and selection survive
  const html = logs.get(w.root) ?? null
  if (shown.root === w.root && shown.html === html) return
  if (shown.root) scrollTops.set(shown.root, logPane.scrollTop)
  const pre = el("pre", { className: "log" })
  if (html === null) pre.textContent = "…"
  else pre.innerHTML = html
  logPane.replaceChildren(pre)
  if (shown.root !== w.root) logPane.scrollTop = scrollTops.get(w.root) ?? 0
  shown = { root: w.root, html }
}

/** Show the tab in Rex. Its state comes back over the event
 * stream like any other tab switch. */
async function focus(tab: string) {
  const res = await fetch("focus", { method: "POST", body: JSON.stringify({ tab }) })
  if (!res.ok) console.error("ah: focus failed:", res.status, await res.text())
}

// Cmd+1–8 for the nth tab and Cmd+9 for the last, as in a browser, and
// Cmd+Opt+Left/Right for the previous and next, wrapping. Keys pressed in a
// frame go to the frame's page, not here.
document.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey || e.shiftKey) return
  const { tabs } = state
  if (tabs.length === 0) return
  let i: number | null = null
  if (!e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const n = Number(e.code.at(-1))
    i = n === 9 ? tabs.length - 1 : n - 1
    if (i >= tabs.length) return
  } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const cur = tabs.findIndex((t) => t.id === state.focused)
    const step = e.key === "ArrowRight" ? 1 : -1
    i = cur === -1 ? 0 : (cur + step + tabs.length) % tabs.length
  } else return
  e.preventDefault()
  if (tabs[i].id !== state.focused) void focus(tabs[i].id)
})

// ⌘I (Ctrl+I in terminal-browser panes) toggles the conversation of the
// tracker in view, as in its own page; the frame only gets the keys itself
// once it has been clicked
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "i" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey)
    return
  const view = state.focused ? docs.get(state.focused)?.view : null
  if (!(view instanceof HTMLIFrameElement) || !view.contentWindow) return
  e.preventDefault()
  // So the compose box it opens takes the keys
  view.focus()
  view.contentWindow.postMessage("ah-toggle-conversation", new URL(view.src).origin)
})

/** The focused workspace's trackers to switch between, and a menu of the
 * parked ones; picking a parked one resumes it */
function renderTrackers(tab: string | null) {
  const root = state.tabs.find((t) => t.id === tab)?.root
  const t = root ? trackers.get(root) : undefined
  if (!tab || !t || (!t.current && !t.active.length && !t.parked.length)) {
    trackerStrip.replaceChildren()
    parkedMenu.hidePopover()
    parkedMenu.replaceChildren()
    return
  }
  const trackerTab = (path: string, className: string) =>
    el(
      "span",
      { className, title: path, onclick: () => void pickTracker(tab, path) },
      trackerName(path),
    )
  // A button for popovertarget, which opens and closes the menu, and leaves
  // closing it on Escape or a click outside to the browser
  const toggle = t.parked.length
    ? [
        Object.assign(
          el(
            "button",
            { className: "tracker-tab parked-toggle", title: "The parked trackers" },
            `${t.parked.length} parked`,
          ),
          { popoverTargetElement: parkedMenu },
        ),
      ]
    : []
  trackerStrip.replaceChildren(
    // By path, which for dated notes directories is oldest first, so
    // switching doesn't reorder them
    ...t.active
      .toSorted()
      .map((path) =>
        trackerTab(path, "tracker-tab" + (path === t.current ? " current" : "")),
      ),
    ...toggle,
  )
  if (!t.parked.length) parkedMenu.hidePopover()
  parkedMenu.replaceChildren(
    ...t.parked.map((path) =>
      el(
        "button",
        {
          title: path,
          onclick: () => {
            parkedMenu.hidePopover()
            void pickTracker(tab, path)
          },
        },
        trackerName(path),
      ),
    ),
  )
}

// The menu opens in the top layer, above a frame, so it's placed by hand:
// under the tracker strip, lined up with the toggle at its right end
parkedMenu.addEventListener("beforetoggle", (e) => {
  const toggle = trackerStrip.querySelector(".parked-toggle")
  if (e.newState !== "open" || !toggle) return
  parkedMenu.style.top = trackerStrip.getBoundingClientRect().bottom + "px"
  parkedMenu.style.right =
    document.documentElement.clientWidth - toggle.getBoundingClientRect().right + "px"
})
// So it closes when the toggle moves out from under it, and on a click in a
// frame, which the browser's light dismiss doesn't see but takes the focus
// from this window
const closeParked = () => parkedMenu.hidePopover()
docPane.addEventListener("scroll", closeParked)
window.addEventListener("resize", closeParked)
window.addEventListener("blur", closeParked)
// Up and down through the parked trackers, as in a menu
parkedMenu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  e.preventDefault()
  const items = [...parkedMenu.children] as HTMLElement[]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const step = e.key === "ArrowDown" ? 1 : -1
  const next = i === -1 ? (step === 1 ? 0 : -1) : (i + step) % items.length
  items.at(next)?.focus()
})

async function pickTracker(tab: string, path: string) {
  const res = await fetch("tracker", {
    method: "POST",
    body: JSON.stringify({ tab, path }),
  })
  if (!res.ok) console.error("ah: couldn't switch trackers:", await res.text())
}

function renderDoc(tab: string | null) {
  const doc = tab ? docs.get(tab) : null
  renderTrackers(tab)
  document.body.classList.toggle("has-doc", !!doc || trackerStrip.childElementCount > 0)
  // A frame scrolls itself, so the pane doesn't
  document.body.classList.toggle("doc-frame", doc?.view.tagName === "IFRAME")
  for (const t of docs.values()) t.view.hidden = t !== doc
  docName.textContent = doc ? (doc.path.split("/").at(-1) ?? "") : ""
  docName.title = doc?.path ?? ""
  if (shownDoc === tab) return
  if (shownDoc) docScrollTops.set(shownDoc, docPane.scrollTop)
  docPane.scrollTop = tab ? (docScrollTops.get(tab) ?? 0) : 0
  shownDoc = tab
}

const events = new EventSource("events")
events.addEventListener("hello", (e) => {
  const v: string = JSON.parse(e.data).version
  if (version && v !== version) location.reload()
  version = v
})
events.addEventListener("state", (e) => {
  state = JSON.parse(e.data)
  render()
})
events.addEventListener("jj", (e) => {
  const { root, html }: { root: string; html: string } = JSON.parse(e.data)
  logs.set(root, html)
  if (root === focusedRoot()) render()
})
events.addEventListener("trackers", (e) => {
  const {
    root,
    ...t
  }: { root: string; current: string | null; active: string[]; parked: string[] } =
    JSON.parse(e.data)
  trackers.set(root, t)
  if (root === focusedRoot()) renderDoc(state.focused)
})
events.addEventListener("doc", (e) => {
  const {
    tab,
    path,
    url,
    frame,
  }: { tab: string; path: string | null; url: string | null; frame: boolean } = JSON.parse(
    e.data,
  )
  const tag = frame ? "IFRAME" : "AH-MARKDOWN"
  let t = docs.get(tab)
  // Gone, or a switch between markdown and html, which needs the other
  // kind of view
  if (t && (!url || t.view.tagName !== tag)) {
    t.view.remove()
    docs.delete(tab)
    t = undefined
  }
  if (url && path && t) {
    t.path = path
    // A frame would reload on any set; ah-markdown ignores the same file
    if (t.view.getAttribute("src") !== url) t.view.setAttribute("src", url)
  } else if (url && path) {
    const view = el(tag.toLowerCase(), { hidden: tab !== state.focused })
    view.setAttribute("src", url)
    // A frame's URL says so already
    if (!frame) view.setAttribute("in", "dashboard")
    docPane.append(view)
    docs.set(tab, { path, view })
  }
  if (tab === state.focused) renderDoc(tab)
})
// The dot: grey when the stream is down or the server stopped pinging it
// (every 15s, routes.ts), amber when the server can't follow Rex
let connected = false
let lastPing = 0
let rexTrouble: string | null = null
function renderStatus() {
  const silent = Date.now() - lastPing > 40_000
  status.className = !connected || silent ? "" : rexTrouble ? "trouble" : "live"
  status.title = !connected
    ? "disconnected"
    : silent
      ? "the server stopped answering"
      : (rexTrouble ?? "connected")
}
setInterval(renderStatus, 5000)
events.addEventListener("ping", () => {
  lastPing = Date.now()
  renderStatus()
})
events.addEventListener("health", (e) => {
  rexTrouble = JSON.parse(e.data).rex
  renderStatus()
})
events.onopen = () => {
  connected = true
  lastPing = Date.now()
  renderStatus()
}
events.onerror = () => {
  connected = false
  renderStatus()
}
