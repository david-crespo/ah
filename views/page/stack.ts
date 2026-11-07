/// <reference lib="dom" />

// A stack's page, served as /stack.js on the pages port; the page (stack_file.ts)
// loads it and /stack.css. It draws the page's stack (stack_data.ts, served
// at _ah/stack) newest first, like jj log: each PR's title, its bookmark and
// how it merges, its summary and files collapsed under it, and a line per
// commit that opens to its description and files. A graph down the left
// joins the commits, with a side lane for a PR that a later one shares a
// base with. Each diff stat is a button that has the server open that diff
// in skepsis (skepsis.ts). Until a PR is on GitHub, its Body button opens its
// body in a doc page, starting the file if there isn't one. Once it is, GitHub
// has the body, so the button gives way to a link to the PR, with GitHub's
// title and where the PR stands there (stack_github.ts, served at
// _ah/stack-github, which comes after the stack since gh is slow). The page
// reloads on every jj operation, so which sections are open is kept across
// reloads, and the last stack is drawn at once while the new one loads.

import type { FileStat, Pr, Stack } from "./stack_data.ts"
import type { GithubPr, GithubPrs } from "./stack_github.ts"

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

const STATES = { draft: "Draft", open: "Open", closed: "Closed", merged: "Merged" }
// Like GitHub's next to a commit: Lucide's check and x, and a dot
const CHECKS = {
  pass: ["Checks passing", '<path d="M20 6 9 17l-5-5"/>'],
  fail: ["Checks failing", '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
  pending: ["Checks running", '<circle cx="12" cy="12" r="5"/>'],
} as const
const REVIEWS: Record<string, [string, string]> = {
  APPROVED: ["approved", "good"],
  CHANGES_REQUESTED: ["changes requested", "bad"],
}

/** A note on the meta line, `cls` good, bad or warn */
const note = (text: string, cls: string, title = "") =>
  `<span class="gh-note ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`

/** The PR's link and where it stands on GitHub, with what doesn't match
 * here: its head, saying which side moved, and its base, which should be the
 * PR below it or trunk */
function githubMeta(pr: Pr, gh: GithubPr, base: string): string {
  const state = gh.state === "OPEN" && gh.isDraft ? "draft" : gh.state.toLowerCase()
  const link = `<a class="gh-pr ${state}" href="${esc(gh.url)}" target="_blank" rel="noreferrer">#${gh.number} ${STATES[state as keyof typeof STATES]}</a>`
  if (gh.state !== "OPEN") return link
  const notes: string[] = []
  if (gh.checks) {
    const [title, icon] = CHECKS[gh.checks]
    notes.push(
      `<a class="gh-checks ${gh.checks}" href="${esc(gh.url)}/checks" target="_blank" rel="noreferrer" title="${title}"><svg viewBox="0 0 24 24" aria-label="${title}">${icon}</svg></a>`,
    )
  }
  const tip = pr.commits[0]?.commit
  const head = gh.headRefOid
  if (tip && !head.startsWith(tip)) {
    const where = `${tip} here, ${head.slice(0, 8)} on GitHub`
    // Pushed as it was last fetched, so the change is here; otherwise GitHub
    // has something newer, like a rebase after the PR below merged
    if (pr.pushed && head.startsWith(pr.pushed))
      notes.push(note("not pushed", "warn", where))
    else notes.push(note("changed on GitHub · fetch", "warn", where))
  }
  if (base && gh.baseRefName !== base)
    notes.push(note(`base is ${gh.baseRefName} on GitHub, ${base} here`, "warn"))
  const review = REVIEWS[gh.reviewDecision]
  if (review) notes.push(note(...review))
  return link + notes.join("")
}

function prCard(pr: Pr, side: boolean, gh: GithubPr | undefined, base: string): string {
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
      <h2><span class="n">${pr.n}.</span> ${esc(gh?.title ?? pr.title)}</h2>
      ${stat(pr.files, { from: pr.base, to: pr.bookmark })}
    </div>
    <div class="pr-meta">${gh ? "" : `<button type="button" class="body-button" data-body="${esc(pr.bookmark)}" title="Open the PR body">${PENCIL} Body</button>`}<span><span class="mono">${esc(pr.bookmark)}</span>${pr.merge ? ` · ${esc(pr.merge)}` : ""}</span>${pr.forksFrom ? note(`forks from ${pr.forksFrom.change.slice(0, 4)}, inside PR ${pr.forksFrom.n}, not its tip`, "warn") : ""}${gh ? githubMeta(pr, gh, base) : ""}</div>
    <details class="more" ${openAttr(`pr-${pr.bookmark}`)}>
      <summary>Summary and ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}</summary>
      ${pr.summary ? paras(pr.summary, "summary") : '<p class="summary empty">No summary yet</p>'}
      ${fileList(pr.files)}
    </details>
    <ol class="commits">${commits.join("")}</ol>
  </section></div>`
}

const githubKey = `ah-stack-github:${location.pathname}`
let github = read<GithubPrs>(sessionStorage, githubKey) ?? {}
let githubError = ""

function draw(stack: Stack, error = "") {
  document.title = stack.title
  // A PR is on a side lane when a later one has the same base
  const side = (pr: Pr) => stack.prs.some((q) => q.n > pr.n && q.base === pr.base)
  // On GitHub, the PR below it, or trunk once that one has merged, since
  // GitHub then retargets this one
  const base = (pr: Pr) =>
    stack.prs.some((q) => q.bookmark === pr.base) && github[pr.base]?.state !== "MERGED"
      ? pr.base
      : stack.trunk
  main.innerHTML = `
    <h1>${esc(stack.title)}</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${githubError ? `<p class="error">GitHub: ${esc(githubError)}</p>` : ""}
    <div class="notes">${stack.notes.map((n) => `<p>${prose(n)}</p>`).join("")}</div>
    ${
      stack.prs.length
        ? `<div class="prs"><svg class="graph"></svg>${stack.prs
            .map((pr) => prCard(pr, side(pr), github[pr.bookmark], base(pr)))
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
let current: Stack | null = cached
let currentError = ""
const redraw = () =>
  draw(current ?? { title: document.title, notes: [], trunk: "", prs: [] }, currentError)
if (cached) redraw()

async function get<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, threadUrl!), { cache: "no-store" })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as T
}

/** GitHub's side, which nothing here hears change, so asked for again now
 * and then while the page is in view */
async function loadGithub() {
  try {
    github = await get<GithubPrs>("stack-github")
    githubError = ""
    write(sessionStorage, githubKey, github)
  } catch (e) {
    githubError = (e as Error).message
  }
  redraw()
}

if (threadUrl) {
  get<Stack>("stack")
    .then((stack) => {
      current = stack
      write(sessionStorage, cacheKey, stack)
    })
    .catch((e: Error) => (currentError = e.message))
    .then(redraw)
    .then(loadGithub)
  setInterval(() => {
    if (document.visibilityState === "visible") void loadGithub()
  }, 60_000)
}
