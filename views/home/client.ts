/// <reference lib="dom" />

// A home page, served as /home.js on the pages port; the page (file.ts) loads
// it and /home.css. It draws the page's data (data.ts, served at _ah/home)
// in four tabs: the live agents (In progress), the items in home.json that
// wait on the user, with how long ago each was written, what finished, and
// every project in workstreams.md with its computed status, its first
// paragraph opening to the rest. A project with a stack page has a Stack
// button by its name wherever it's shown, and a waiting item can link to a
// file; both ask the server to open it in a window. The tab is kept in the URL hash, so a
// reload stays on it, and which projects are open is kept across redraws and
// reloads. The data is read again when the server says a file changed, and
// every 5 seconds while the page is in view, since agents start and stop
// without any file changing; an unchanged answer draws nothing, so an open
// project or a selection stays put.

import type { AgentRow, Home, Status, Waiting } from "./data.ts"
import { escapeHtml } from "../escape.ts"
import { sameProject } from "./names.ts"

const threadUrl = (() => {
  const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")
  return script?.dataset.ahThread ? new URL(script.dataset.ahThread, location.href) : null
})()

const main = document.querySelector("main")!

/** `text`, already HTML, as a link to `href`, unless that would run script */
const link = (href: string, text: string, cls = "") =>
  /^\s*(javascript|data|vbscript):/i.test(href)
    ? text
    : `<a${cls ? ` class="${cls}"` : ""} href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${text}</a>`

/** `text`, already HTML, as a button that opens `file` (as home.json has it)
 * in a window */
const fileLink = (file: string, text: string, cls = "") =>
  `<button type="button" class="file${cls ? ` ${cls}` : ""}" data-file="${escapeHtml(file)}">${text}</button>`

/** A Stack button for a project with a stack page, else nothing */
type StackButton = (project: string) => string

/** Escaped, with `code`, **bold** and [text](url) */
const inline = (s: string) =>
  escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    // On escaped text, so the URL is unescaped before link escapes it again
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) =>
      link(url.replaceAll("&amp;", "&"), text),
    )

const time = (d: Date) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
const isToday = (d: Date) => d.toDateString() === new Date().toDateString()
/** HH:MM today, else MM-DD */
const when = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(+d)) return iso
  return isToday(d)
    ? time(d)
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
/** How long ago, in round numbers */
const age = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  if (min < 48 * 60) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 60 / 24)} d`
}
/** A written item is dimmed once it's this old */
const STALE = 6 * 60 * 60_000

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null")
  } catch {
    return null
  }
}
const write = (key: string, value: unknown) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked: it's only for reloads */
  }
}

const openKey = `ah-home-open:${location.pathname}`
const open = new Set(read<string[]>(openKey) ?? [])
document.addEventListener(
  "toggle",
  (e) => {
    const key = (e.target as HTMLElement).dataset?.key
    if (!key) return
    if ((e.target as HTMLDetailsElement).open) open.add(key)
    else open.delete(key)
    write(openKey, [...open])
  },
  true,
)

const CHIPS: Record<Status, string> = { "needs you": "you", running: "run", idle: "idle" }
const chip = (status: Status) => `<span class="chip ${CHIPS[status]}">${status}</span>`

const empty = (text: string) => `<li class="empty">${text}</li>`

/** A live agent. Its row is a container, so a panel can open under it. */
const agentRow = (a: AgentRow, stack: StackButton) => {
  const project = a.project ?? a.cwd.split("/").filter(Boolean).at(-1) ?? a.label
  const what = a.asked ?? a.summary
  return `<li class="row agent" data-id="${escapeHtml(a.id)}">
    <div class="top">
      <span><span class="proj">${escapeHtml(project)}</span>${a.project ? stack(a.project) : ""}</span>
      <span class="meta">${escapeHtml(a.harness)} ${a.busy ? '<span class="chip run">working</span>' : '<span class="chip idle">idle</span>'}</span>
    </div>
    ${what ? `<div>${escapeHtml(what)}</div>` : `<div class="note">${escapeHtml(a.cwd.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~"))}</div>`}
  </li>`
}

const waitingRow = (w: Waiting, i: number, stack: StackButton) => {
  const at = new Date(w.written)
  const valid = !isNaN(+at)
  const stale = valid && Date.now() - +at > STALE
  const text = escapeHtml(w.text)
  return `<li class="row${stale ? " stale" : ""}">
    <span class="n">${i + 1}</span>
    <div>
      <div class="top">
        <span><span class="proj">${escapeHtml(w.project)}</span>${stack(w.project)}</span>
        ${valid ? `<span class="meta" title="${escapeHtml(at.toLocaleString())}">${age(Date.now() - +at)}</span>` : ""}
      </div>
      <div>${w.link ? link(w.link, text) : w.file ? fileLink(w.file, text) : text}</div>
      ${w.note ? `<div class="note">${escapeHtml(w.note)}</div>` : ""}
      ${w.links
        .map((l) =>
          l.href
            ? link(l.href, escapeHtml(l.label), "more")
            : fileLink(l.file!, escapeHtml(l.label), "more"),
        )
        .join("")}
      ${stale ? `<div class="note">not rechecked since ${when(w.written)}</div>` : ""}
    </div>
  </li>`
}

const TABS = ["progress", "waiting", "finished", "projects"] as const
type Tab = (typeof TABS)[number]
const hashTab = () => {
  const tab = location.hash.slice(1)
  return (TABS as readonly string[]).includes(tab) ? (tab as Tab) : null
}

function html(home: Home, error: string): string {
  const { file, projects } = home
  const agents = home.agents.filter((a) => !a.self)
  const finished = file.finished.toSorted((a, b) => +new Date(b.at) - +new Date(a.at))
  const selected = hashTab() ?? (file.waiting.length ? "waiting" : "progress")
  const tab = (id: Tab, label: string, count: number, you = false) =>
    `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === selected}">${label}<span class="count${you && count ? " you" : ""}">${count}</span></button>`
  const stack: StackButton = (project) =>
    file.projects.some((p) => p.stack && sameProject(p.name, project))
      ? `<button type="button" class="stack" data-project="${escapeHtml(project)}">Stack</button>`
      : ""
  const panel = (id: Tab, body: string) =>
    `<section class="panel"${id === selected ? "" : " hidden"}>${body}</section>`

  const groups = [...new Set(projects.map((p) => p.group))].map((group) => {
    const rows = projects
      .filter((p) => p.group === group)
      .map((p) => {
        const key = `p-${p.group}-${p.name}`
        const [first = "", ...rest] = p.paragraphs
        return `<li class="row"><details data-key="${escapeHtml(key)}"${open.has(key) ? " open" : ""}>
          <summary>
            <div><span class="proj">${escapeHtml(p.name)}</span> ${chip(p.status)}${stack(p.name)}</div>
            <p class="first">${inline(first)}</p>
          </summary>
          ${rest.map((para) => `<p>${inline(para)}</p>`).join("")}
        </details></li>`
      })
    return `<h3>${escapeHtml(group)}</h3><ul class="card projects">${rows.join("")}</ul>`
  })

  return `
    <div class="head">
      <h1>${escapeHtml(file.title || document.title)}</h1>
      <span class="asof"></span>
    </div>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <div class="tabs" role="tablist">
      ${tab("progress", "In progress", agents.length)}
      ${tab("waiting", "Waiting on you", file.waiting.length, true)}
      ${tab("finished", "Finished", finished.length)}
      ${tab("projects", "All projects", projects.length)}
    </div>
    ${panel("progress", `<ul class="card">${agents.map((a) => agentRow(a, stack)).join("") || empty("Nothing is running.")}</ul>`)}
    ${panel("waiting", `<ol class="card waiting">${file.waiting.map((w, i) => waitingRow(w, i, stack)).join("") || empty("Nothing is waiting on you.")}</ol>`)}
    ${panel(
      "finished",
      `<ul class="card finished">${
        finished
          .map(
            (f) =>
              `<li class="row"><span class="at" title="${escapeHtml(f.at)}">${escapeHtml(when(f.at))}</span><div><span class="proj">${escapeHtml(f.project)}.</span> ${escapeHtml(f.text)}</div></li>`,
          )
          .join("") || empty("Nothing has finished.")
      }</ul>`,
    )}
    ${panel("projects", groups.join("") || `<p class="empty">No projects in workstreams.md.</p>`)}`
}

const cacheKey = `ah-home-data:${location.pathname}`
let current = read<Home>(cacheKey)
let error = ""
/** Why the last Stack button or file link didn't open, until one does */
let openError = ""
let drawn = ""

function draw() {
  if (!current) {
    if (error) main.innerHTML = drawn = `<p class="error">${escapeHtml(error)}</p>`
    return
  }
  if (current.file.title) document.title = current.file.title
  const next = html(current, [error, openError].filter(Boolean).join("; "))
  if (next !== drawn) {
    main.innerHTML = drawn = next
    // On a narrow screen the tabs scroll, and the selected one may be off it
    main
      .querySelector('.tabs [aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }
  const asof = main.querySelector(".asof")
  if (asof) asof.textContent = `read ${time(new Date(current.readAt))}`
}

main.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-tab]")
  if (!button) return
  history.replaceState(null, "", `#${button.dataset.tab}`)
  draw()
})
addEventListener("hashchange", draw)

// A Stack button or a file link: the server opens it in a window
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(
    "button[data-project], button[data-file]",
  )
  if (!button || !threadUrl) return
  // In a project's summary, the click shouldn't also open the project
  e.preventDefault()
  const { project, file } = button.dataset
  try {
    const res = await fetch(new URL("open", threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(project ? { project } : { file }),
    })
    openError = res.ok ? "" : `Can't open it: ${(await res.text()) || res.status}`
  } catch (e) {
    openError = `Can't open it: ${(e as Error).message}`
  }
  draw()
})

if (current) draw()

let loading = false
let dirty = false

/** One load at a time; asks during one make one more. A failed load, or
 * files that couldn't be read, keep the last good draw and say why. */
async function load() {
  if (loading) {
    dirty = true
    return
  }
  loading = true
  try {
    do {
      dirty = false
      try {
        const res = await fetch(new URL("home", threadUrl!), { cache: "no-store" })
        if (!res.ok) throw new Error((await res.text()) || `${res.status}`)
        const home = (await res.json()) as Home
        error = home.errors.join("; ")
        if (!error || !current) {
          current = home
          write(cacheKey, home)
        }
      } catch (e) {
        error = `Can't read the page's data: ${(e as Error).message}`
      }
      draw()
    } while (dirty)
  } finally {
    loading = false
  }
}

if (threadUrl) {
  void load()
  document.addEventListener("ah-data", () => void load())
  setInterval(() => {
    if (document.visibilityState === "visible") void load()
  }, 5_000)
}
