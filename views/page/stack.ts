/// <reference lib="dom" />

// A stack's page, served as /view/page/stack.js; the page (stack_file.ts)
// loads it and /stack.css. It draws the page's stack (stack_data.ts, served
// at _ah/stack) newest first, like jj log: each PR's title, its bookmark and
// how it merges, its summary and files collapsed under it, and a line per
// commit that opens to its description and files. A graph down the left
// joins the commits, with a side lane for a PR that a later one shares a
// base with. Each diff stat is a button that has the server open that diff
// in skepsis (skepsis.ts), and each PR's Body button opens its body in a doc
// page, starting the file if there isn't one. The page reloads on every jj operation, so which
// sections are open is kept across reloads, and the last stack is drawn at
// once while the new one loads.

import type { FileStat, Pr, Stack } from "./stack_data.ts"

const threadUrl = (() => {
  const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")
  return script?.dataset.ahThread ? new URL(script.dataset.ahThread, location.href) : null
})()

const main = document.querySelector("main")!

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  )
/** Escaped, with `code` in backticks */
const prose = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>")
/** Hard-wrapped text as paragraphs: lines unwrapped, blank lines kept */
const paras = (s: string, cls: string) =>
  s
    .split(/\n\s*\n/)
    .map((p) => `<p class="${cls}">${prose(p.trim().replace(/\s*\n\s*/g, " "))}</p>`)
    .join("")

const sum = (files: FileStat[], key: "add" | "del") => files.reduce((n, f) => n + f[key], 0)
const counts = (add: number, del: number) =>
  `<span class="add">+${add}</span> <span class="del">−${del}</span>`

/** The diff stat, as a button that opens `diff` in skepsis */
const stat = (files: FileStat[], diff: { rev: string } | { from: string; to: string }) =>
  `<button type="button" class="short mono" data-diff="${esc(JSON.stringify(diff))}" title="Open in skepsis">${counts(sum(files, "add"), sum(files, "del"))}</button>`

const fileList = (files: FileStat[]) =>
  `<ul class="files mono">${files
    .map(
      (f) =>
        `<li><span>${f.status}</span><span class="path">${esc(f.path)}</span><span class="n">${counts(f.add, f.del)}</span></li>`,
    )
    .join("")}</ul>`

const read = <T>(storage: Storage, key: string): T | null => {
  try {
    return JSON.parse(storage.getItem(key) ?? "null")
  } catch {
    return null
  }
}
const write = (storage: Storage, key: string, value: unknown) => {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked: it's only for reloads */
  }
}

const openKey = `ah-stack-open:${location.pathname}`
const open = new Set(read<string[]>(sessionStorage, openKey) ?? [])
const openAttr = (key: string) => `data-key="${esc(key)}"${open.has(key) ? " open" : ""}`
document.addEventListener(
  "toggle",
  (e) => {
    const details = e.target as HTMLDetailsElement
    const key = details.dataset?.key
    if (!key) return
    if (details.open) open.add(key)
    else open.delete(key)
    write(sessionStorage, openKey, [...open])
  },
  true,
)

// Lucide's pencil
const PENCIL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`

function prCard(pr: Pr, side: boolean): string {
  const commits = pr.commits.map((c) => {
    const [title, ...rest] = c.description.split("\n")
    const body = rest.join("\n").trim()
    return `<li><details class="commit" ${openAttr(`c-${c.change}`)}>
      <summary>
        <span class="mono cid" title="${c.change} @ ${c.commit}">${esc(c.short)}</span>
        <span class="title">${esc(title || "(no description)")}</span>
        ${stat(c.files, { rev: c.change })}
      </summary>
      <div class="detail">
        ${body ? paras(body, "body") : '<p class="body empty">No description body</p>'}
        ${fileList(c.files)}
      </div>
    </details></li>`
  })
  return `<div class="row${side ? " side" : ""}"><section class="pr">
    <div class="pr-head">
      <h2><span class="n">${pr.n}.</span> ${esc(pr.title)}</h2>
      ${stat(pr.files, { from: pr.base, to: pr.bookmark })}
    </div>
    <div class="pr-meta"><button type="button" class="body-button" data-body="${esc(pr.bookmark)}" title="Open the PR body">${PENCIL} Body</button><span><span class="mono">${esc(pr.bookmark)}</span>${pr.merge ? ` · ${esc(pr.merge)}` : ""}</span></div>
    <details class="more" ${openAttr(`pr-${pr.bookmark}`)}>
      <summary>Summary and ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}</summary>
      ${pr.summary ? paras(pr.summary, "summary") : '<p class="summary empty">No summary yet</p>'}
      ${fileList(pr.files)}
    </details>
    <ol class="commits">${commits.join("")}</ol>
  </section></div>`
}

function draw(stack: Stack, error = "") {
  document.title = stack.title
  // A PR is on a side lane when a later one has the same base
  const side = (pr: Pr) => stack.prs.some((q) => q.n > pr.n && q.base === pr.base)
  main.innerHTML = `
    <h1>${esc(stack.title)}</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <div class="notes">${stack.notes.map((n) => `<p>${prose(n)}</p>`).join("")}</div>
    ${
      stack.prs.length
        ? `<div class="prs"><svg class="graph"></svg>${stack.prs
            .map((pr) => prCard(pr, side(pr)))
            .join("")}<div class="trunk mono">${esc(stack.prs.at(-1)!.base)}</div></div>`
        : `<p class="empty">No PRs in stack.json yet</p>`
    }`
  drawGraph()
}

// Lane x positions in the gutter: the main line, and a side lane
const LANES = [10, 38] as const

/** The lines and dots, measured from where the commits are */
function drawGraph() {
  const box = main.querySelector<HTMLElement>(".prs")
  const svg = box?.querySelector("svg.graph")
  if (!box || !svg) return
  const top = box.getBoundingClientRect().top
  const mid = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.top - top + r.height / 2
  }
  const dots = (row: Element) => [...row.querySelectorAll(".commit > summary")].map(mid)
  const rows = [...box.querySelectorAll(".row")]
  const [a, b] = LANES
  const trunkY = mid(box.querySelector(".trunk")!)
  const mainYs = rows.filter((r) => !r.classList.contains("side")).flatMap(dots)
  let paths = `<path d="M${a} ${mainYs[0] ?? trunkY} V${trunkY}"/>`
  const circles = mainYs.map((y) => [a, y])
  // A side branch runs down from its newest commit and joins the main line a
  // little below its oldest one, like jj's ├─╯
  for (const row of rows.filter((r) => r.classList.contains("side"))) {
    const ys = dots(row)
    if (!ys.length) continue
    const cardBottom = row.querySelector(".pr")!.getBoundingClientRect().bottom - top
    const join = Math.min(ys.at(-1)! + 24, cardBottom + 8)
    paths += `<path d="M${b} ${ys[0]} V${join - 12} A12 12 0 0 1 ${b - 12} ${join} H${a}"/>`
    circles.push(...ys.map((y) => [b, y]))
  }
  const diamond = `<rect x="${a - 4}" y="${trunkY - 4}" width="8" height="8" transform="rotate(45 ${a} ${trunkY})"/>`
  svg.setAttribute("height", String(box.offsetHeight))
  svg.innerHTML =
    paths +
    circles.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5"/>`).join("") +
    diamond
}
// Opening a section moves everything below it
document.addEventListener("toggle", drawGraph, true)
addEventListener("resize", drawGraph)
void document.fonts?.ready.then(drawGraph)

// A diff stat: the server starts skepsis on the diff, or shows the one
// already running. A PR's Body button: the server opens its body's doc page.
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(
    "button[data-diff], button[data-body]",
  )
  if (!button) return
  // In a commit's line, the click shouldn't also open it
  e.preventDefault()
  if (!threadUrl || button.classList.contains("busy")) return
  const { diff, body } = button.dataset
  const title = diff ? "Open in skepsis" : "Open the PR body"
  button.classList.add("busy")
  button.classList.remove("failed")
  let error = ""
  try {
    const res = await fetch(new URL(diff ? "skepsis" : "pr-body", threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: diff ?? JSON.stringify({ bookmark: body }),
    })
    if (!res.ok) error = (await res.text()) || `${res.status}`
  } catch (e) {
    error = String(e)
  }
  button.classList.remove("busy")
  button.classList.toggle("failed", !!error)
  button.title = error || title
})

const cacheKey = `ah-stack:${location.pathname}`
const cached = read<Stack>(sessionStorage, cacheKey)
if (cached) draw(cached)
if (threadUrl) {
  fetch(new URL("stack", threadUrl), { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error(await res.text())
      const stack: Stack = await res.json()
      write(sessionStorage, cacheKey, stack)
      draw(stack)
    })
    .catch((e: Error) =>
      draw(cached ?? { title: document.title, notes: [], prs: [] }, e.message),
    )
}
