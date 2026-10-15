/// <reference lib="dom" />

// Browser half of the dashboard, served as /app/dashboard/client.js to
// page.html. It follows the server's event stream (routes.ts): the Rex
// tabs in jj workspaces and which is focused, each workspace's jj log, and
// each tab's file (its agent's), shown with <ah-markdown> from
// ../markdown/preview.js, or an html file in a frame of its page on the html
// app's port.

import type { State } from "./workspace.ts"

const byId = (id: string) => document.getElementById(id)!
const strip = byId("strip")
const logPane = byId("log-pane")
const docPane = byId("doc-pane")
const docName = byId("doc-name")
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

function renderDoc(tab: string | null) {
  const doc = tab ? docs.get(tab) : null
  document.body.classList.toggle("has-doc", !!doc)
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
    docPane.append(view)
    docs.set(tab, { path, view })
  }
  if (tab === state.focused) renderDoc(tab)
})
events.onopen = () => {
  status.className = "live"
  status.title = "connected"
}
events.onerror = () => {
  status.className = ""
  status.title = "disconnected"
}
