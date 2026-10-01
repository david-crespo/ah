/// <reference lib="dom" />

// Browser half of the dashboard, served as /app/dashboard/client.js to
// page.html. It follows the server's event stream (routes.ts): the
// workspaces and which is focused, each workspace's jj log, and each one's
// file, shown with <ah-markdown> from ../markdown/preview.js.

import type { State } from "./workspace.ts"

const byId = (id: string) => document.getElementById(id)!
const strip = byId("strip")
const header = byId("header")
const logPane = byId("log-pane")
const docPane = byId("doc-pane")
const docName = byId("doc-name")
const status = byId("status")

let version: string | null = null
let state: State = { focused: null, workspaces: [] }
const logs = new Map<string, string>() // root -> html
const scrollTops = new Map<string, number>() // root -> scroll position, kept across tab switches
let shown: { root: string | null; html: string | null } = { root: null, html: null }
// root -> { path, view }, each view an <ah-markdown> (from
// ../markdown/preview.js) that stays in the pane while its workspace has
// the file, hidden unless focused, so a tab switch keeps its scroll
// and doesn't reconnect
const docs = new Map<string, { path: string; view: HTMLElement }>()
const docScrollTops = new Map<string, number>()
let shownDoc: string | null = null // root

function el(tag: string, attrs: Partial<HTMLElement>, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  Object.assign(e, attrs)
  e.append(...children)
  return e
}

function render() {
  const { focused, workspaces } = state
  strip.replaceChildren(
    ...workspaces.map((w) => {
      const chip = el(
        "span",
        {
          className: "chip" + (w.root === focused ? " focused" : ""),
          title: w.tabs.map((t) => t.name).join("\n"),
        },
        w.name,
      )
      if (w.tabs.length > 1) {
        chip.append(el("span", { className: "count" }, "×" + w.tabs.length))
      }
      return chip
    }),
  )

  const w = workspaces.find((w) => w.root === focused)
  renderDoc(w?.root ?? null)
  if (!w) {
    header.replaceChildren()
    logPane.replaceChildren(
      el("p", { className: "empty" }, "No jj workspace in the focused tab."),
    )
    shown = { root: null, html: null }
    return
  }
  document.title = w.name
  header.replaceChildren(el("h1", {}, w.name), el("span", { className: "root" }, w.root))

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

function renderDoc(root: string | null) {
  const doc = root ? docs.get(root) : null
  document.body.classList.toggle("has-doc", !!doc)
  for (const t of docs.values()) t.view.hidden = t !== doc
  docName.textContent = doc ? (doc.path.split("/").at(-1) ?? "") : ""
  docName.title = doc?.path ?? ""
  if (shownDoc === root) return
  if (shownDoc) docScrollTops.set(shownDoc, docPane.scrollTop)
  docPane.scrollTop = root ? (docScrollTops.get(root) ?? 0) : 0
  shownDoc = root
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
  if (root === state.focused) render()
})
events.addEventListener("doc", (e) => {
  const { root, path, url }: { root: string; path: string | null; url: string | null } =
    JSON.parse(e.data)
  const t = docs.get(root)
  if (!url || !path) {
    t?.view.remove()
    docs.delete(root)
  } else if (t) {
    t.path = path
    t.view.setAttribute("src", url) // a no-op for the same file
  } else {
    const view = el("ah-markdown", { hidden: root !== state.focused })
    view.setAttribute("src", url)
    docPane.append(view)
    docs.set(root, { path, view })
  }
  if (root === state.focused) renderDoc(root)
})
events.onopen = () => {
  status.className = "live"
  status.title = "connected"
}
events.onerror = () => {
  status.className = ""
  status.title = "disconnected"
}
