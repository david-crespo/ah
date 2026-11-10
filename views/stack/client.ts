/// <reference lib="dom" />

// A stack's page, served as /stack.js on the pages port; the page (file.ts)
// loads it and /stack.css. It draws the page's stack (data.ts, served
// at _ah/stack) newest first, like jj log: each PR's title, its bookmark and
// how it merges, its summary and files collapsed under it, and a line per
// commit that opens to its description and files. Once a PR is pushed, a line
// under its newest commits marks the ones still to push, with a Push button
// on it; a PR whose bookmark isn't on the remote yet has its Push button by
// its Body button. Push has the server push the bookmark once the user
// confirms it in a dialog the server shows (push.ts), and jj's answer shows
// on the PR. Commits below a fork
// that no PR's bookmark is on get a card of their own, shared by the PRs
// above. A graph down the left joins the commits, like jj log's. Each diff
// stat is a button that has the server open that diff in skepsis
// (skepsis.ts). Until a PR is on GitHub, its Body button opens its body in a
// doc page, starting the file if there isn't one. Once it is, GitHub has the
// body, so the button gives way to a link to the PR, with GitHub's
// title and where the PR stands there (github.ts, served at
// _ah/stack-github, which comes after the stack since gh is slow). The stack
// is read again, without a reload, when the server says its data changed:
// on every jj operation, and when stack.json or a body is saved. Which
// sections are open is kept across reloads and redraws, and after a reload
// the last stack is drawn at once while the new one loads.

import type { Commit, FileStat, Group, Pr, Shared, Stack } from "./data.ts"
import type { GithubPr, GithubPrs } from "./github.ts"
import { escapeHtml } from "../escape.ts"

const threadUrl = (() => {
  const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")
  return script?.dataset.ahThread ? new URL(script.dataset.ahThread, location.href) : null
})()

const main = document.querySelector("main")!

/** Escaped, with `code` in backticks */
const prose = (s: string) => escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>")
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
  `<button type="button" class="short mono" data-diff="${escapeHtml(JSON.stringify(diff))}" title="Open in skepsis">${counts(sum(files, "add"), sum(files, "del"))}</button>`

const fileList = (files: FileStat[]) =>
  `<ul class="files mono">${files
    .map(
      (f) =>
        `<li><span>${f.status}</span><span class="path">${escapeHtml(f.path)}</span><span class="n">${counts(f.add, f.del)}</span></li>`,
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
const openAttr = (key: string) =>
  `data-key="${escapeHtml(key)}"${open.has(key) ? " open" : ""}`
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
// A dot for CI, coloured by how the checks stand
const CHECKS = {
  pass: "CI checks passing",
  fail: "CI checks failing",
  pending: "CI checks running",
}
// Lucide's check and x, with the review's word as the tooltip
const REVIEWS: Record<string, [string, string, string]> = {
  APPROVED: ["approved", "good", '<path d="M20 6 9 17l-5-5"/>'],
  CHANGES_REQUESTED: [
    "changes requested",
    "bad",
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  ],
}

/** A note on the meta line, `cls` good, bad or warn */
const note = (text: string, cls: string, title = "") =>
  `<span class="gh-note ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`

/** The PR's link and where it stands on GitHub, with what doesn't match
 * here: its head, saying which side moved, and its base, which should be the
 * PR below it or trunk */
function githubMeta(pr: Pr, gh: GithubPr, base: string): string {
  const state = gh.state === "OPEN" && gh.isDraft ? "draft" : gh.state.toLowerCase()
  const link = `<a class="gh-pr ${state}" href="${escapeHtml(gh.url)}" target="_blank" rel="noreferrer">#${gh.number} ${STATES[state as keyof typeof STATES]}</a>`
  if (gh.state !== "OPEN") return link
  const notes: string[] = []
  if (gh.checks) {
    const title = CHECKS[gh.checks]
    notes.push(
      `<a class="gh-checks ${gh.checks}" href="${escapeHtml(gh.url)}/checks" target="_blank" rel="noreferrer" title="${title}" aria-label="${title}"></a>`,
    )
  }
  const tip = pr.commits[0]?.commit
  const head = gh.headRefOid
  if (tip && !head.startsWith(tip)) {
    const where = `${tip} here, ${head.slice(0, 8)} on GitHub`
    // Pushed as it was last fetched, so the change is here, and the line in
    // the commit list shows it unless the bookmark only moved back. Otherwise
    // GitHub has something newer, like a rebase after the PR below merged.
    if (!pr.pushed || !head.startsWith(pr.pushed))
      notes.push(note("changed on GitHub · fetch", "warn", where))
    else if (!pr.unpushed) notes.push(note("not pushed", "warn", where))
  }
  if (base && gh.baseRefName !== base)
    notes.push(note(`base is ${gh.baseRefName} on GitHub, ${base} here`, "warn"))
  const review = REVIEWS[gh.reviewDecision]
  if (review) {
    const [text, cls, icon] = review
    notes.push(
      `<span class="gh-note gh-review ${cls}" title="Review on GitHub: ${text}"><svg viewBox="0 0 24 24" aria-label="${text}">${icon}</svg></span>`,
    )
  }
  return link + notes.join("")
}

/** Pushes from this page by bookmark: out ("busy"), or how they ended, which
 * shows on the PR until the page reloads or it's pushed again */
const pushes = new Map<string, "busy" | { how: "ok" | "bad" | "cancelled"; text: string }>()

/** The Push button for `pr`, disabled while its push is out */
function pushButton(pr: Pr): string {
  const busy = pushes.get(pr.bookmark) === "busy"
  return `<button type="button" class="push-button" data-push="${escapeHtml(pr.bookmark)}" title="${busy ? "Waiting for you to confirm in ah's dialog, then pushing" : `Push ${escapeHtml(pr.bookmark)}, after a dialog asks you`}"${busy ? " disabled" : ""}>${busy ? "Pushing…" : "Push"}</button>`
}

/** How the PR's last push from this page went, if there was one */
function pushResult(pr: Pr): string {
  const result = pushes.get(pr.bookmark)
  if (!result || result === "busy") return ""
  return `<pre class="push-result ${result.how}">${escapeHtml(result.text)}</pre>`
}

/** The commits, with a line under the first `unpushed` of them, the newest,
 * when there are any, with `button` on it */
function commitList(commits: Commit[], unpushed = 0, button = ""): string {
  const items = commits.map((c) => {
    const [title, ...rest] = c.description.split("\n")
    const body = rest.join("\n").trim()
    return `<li><details class="commit" ${openAttr(`c-${c.change}`)}>
      <summary>
        <span class="mono cid" title="${c.change} @ ${c.commit}">${escapeHtml(c.short)}</span>
        <span class="title">${escapeHtml(title || "(no description)")}</span>
        ${stat(c.files, { rev: c.change })}
      </summary>
      <div class="detail">
        ${body ? paras(body, "body") : '<p class="body empty">No description body</p>'}
        ${fileList(c.files)}
      </div>
    </details></li>`
  })
  if (unpushed)
    items.splice(
      unpushed,
      0,
      `<li class="to-push"><span>↑ ${unpushed} to push</span>${button}${unpushed < commits.length ? '<span class="pushed">pushed ↓</span>' : ""}</li>`,
    )
  return `<ol class="commits">${items.join("")}</ol>`
}

function prCard(pr: Pr, gh: GithubPr | undefined, base: string): string {
  // Before a first push, all of them are to push, which goes without saying
  const unpushed = pr.pushed ? pr.unpushed : 0
  // Its bookmark is new on the remote, so the button goes by Body
  const fresh = !pr.pushed && pr.commits.length > 0
  return `<section class="pr">
    <div class="pr-head">
      <h2><span class="n">${pr.n}.</span> ${escapeHtml(gh?.title ?? pr.title)}</h2>
      ${pr.diff ? stat(pr.files, pr.diff) : ""}
    </div>
    <div class="pr-meta">${gh ? "" : `<button type="button" class="body-button" data-body="${escapeHtml(pr.bookmark)}" title="Open the PR body">${PENCIL} Body</button>`}${fresh ? pushButton(pr) : ""}<span><span class="mono">${escapeHtml(pr.bookmark)}</span>${pr.merge ? ` · ${escapeHtml(pr.merge)}` : ""}</span>${pr.missing ? note("no bookmark yet", "warn") : ""}${gh ? githubMeta(pr, gh, base) : ""}</div>
    ${pushResult(pr)}
    <details class="more" ${openAttr(`pr-${pr.bookmark}`)}>
      <summary>Summary and ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}</summary>
      ${pr.summary ? paras(pr.summary, "summary") : '<p class="summary empty">No summary yet</p>'}
      ${fileList(pr.files)}
    </details>
    ${commitList(pr.commits, unpushed, unpushed ? pushButton(pr) : "")}
  </section>`
}

/** Commits below a fork with no PR's bookmark on them, so each PR above
 * would include them on GitHub */
function sharedCard(group: Shared): string {
  const { prs } = group
  const bookmark = group.head !== group.commits[0].change
  return `<section class="pr shared">
    <div class="pr-head">
      <h2>${bookmark ? `<span class="mono">${escapeHtml(group.head)}</span>` : "No bookmark"}</h2>
      ${group.diff ? stat(group.files, group.diff) : ""}
    </div>
    <div class="pr-meta">${note(`shared by PRs ${prs.slice(0, -1).join(", ")} and ${prs.at(-1)}`, "warn")}</div>
    ${commitList(group.commits)}
  </section>`
}

const githubKey = `ah-stack-github:${location.pathname}`
let github = read<GithubPrs>(sessionStorage, githubKey) ?? {}
let githubError = ""
let drawn = ""

/** Each row's lane in the graph, like jj log's: the lane on its way down to
 * the row, else the first free one. When another lane is already on its way
 * to the row's base, the row joins it just below itself, like jj's ├─╯;
 * otherwise its lane goes on down to its base. Rows with no commits aren't
 * in the graph. */
function graphLanes(rows: Group[]): { lane: number; join: number | null }[] {
  const heads = new Set(rows.filter((r) => r.commits.length).map((r) => r.head))
  /** Per lane, the head it's on its way to, or null when it's free */
  const waiting: (string | null)[] = []
  return rows.map((row) => {
    if (!row.commits.length) return { lane: 0, join: null }
    let lane = waiting.indexOf(row.head)
    if (lane < 0) lane = waiting.includes(null) ? waiting.indexOf(null) : waiting.length
    // Every base below the graph is trunk
    const to = heads.has(row.base) ? row.base : ""
    const join = waiting.indexOf(to)
    waiting[lane] = join < 0 ? to : null
    return { lane, join: join < 0 ? null : join }
  })
}

function draw(stack: Stack, error = "") {
  document.title = stack.title
  const { rows } = stack
  const lanes = graphLanes(rows)
  /** The nearest PR under a row, past any shared commits */
  const prBelow = (row: Group): Pr | undefined => {
    const below = rows.find((r) => r.head === row.base)
    return below && ("n" in below ? below : prBelow(below))
  }
  // On GitHub, the PR below it, or trunk once that one has merged, since
  // GitHub then retargets this one
  const base = (pr: Pr) => {
    const below = prBelow(pr)
    return below && github[below.bookmark]?.state !== "MERGED"
      ? below.bookmark
      : stack.trunk
  }
  const html = `
    <h1>${escapeHtml(stack.title)}</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${githubError ? `<p class="error">GitHub: ${escapeHtml(githubError)}</p>` : ""}
    <div class="notes">${stack.notes.map((n) => `<p>${prose(n)}</p>`).join("")}</div>
    ${
      rows.length
        ? `<div class="prs"><svg class="graph"></svg>${rows
            .map((row, i) => {
              const { lane, join } = lanes[i]
              return `<div class="row" style="--lane: ${lane}" data-lane="${lane}"${join === null ? "" : ` data-join="${join}"`}>${"n" in row ? prCard(row, github[row.bookmark], base(row)) : sharedCard(row)}</div>`
            })
            .join(
              "",
            )}<div class="trunk mono">${escapeHtml(rows.findLast((r) => r.commits.length)?.base ?? "")}</div></div>`
        : `<p class="empty">No PRs in stack.json yet</p>`
    }`
  if (html === drawn) return
  main.innerHTML = drawn = html
  paintButtons()
  drawGraph()
}

/** A lane's x position in the gutter, which matches the row's indent */
const laneX = (lane: number) => 10 + 28 * lane

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
  const a = laneX(0)
  const trunkY = mid(box.querySelector(".trunk")!)
  let paths = ""
  const circles: number[][] = []
  /** Per lane, where the line on it so far starts */
  const from: (number | undefined)[] = []
  for (const row of box.querySelectorAll<HTMLElement>(".row")) {
    const ys = [...row.querySelectorAll(".commit > summary")].map(mid)
    if (!ys.length) continue
    const lane = Number(row.dataset.lane)
    const x = laneX(lane)
    if (from[lane] !== undefined) paths += `<path d="M${x} ${from[lane]} V${ys[0]}"/>`
    circles.push(...ys.map((y) => [x, y]))
    from[lane] = row.dataset.join ? undefined : ys[0]
    if (!row.dataset.join) continue
    // Down from its newest commit to a little below its oldest, then across
    // to the lane it joins
    const cardBottom = row.querySelector(".pr")!.getBoundingClientRect().bottom - top
    const join = Math.min(ys.at(-1)! + 24, cardBottom + 8)
    paths += `<path d="M${x} ${ys[0]} V${join - 12} A12 12 0 0 1 ${x - 12} ${join} H${laneX(Number(row.dataset.join))}"/>`
  }
  for (const [lane, y] of from.entries())
    if (y !== undefined) paths += `<path d="M${laneX(lane)} ${y} V${trunkY}"/>`
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

const BUTTONS = "button[data-diff], button[data-body]"
/** Each button's request while it's out ("busy"), or the error it failed
 * with, by its data-diff or data-body, so a redraw keeps them */
const requests = new Map<string, string>()

function paintButtons() {
  for (const button of main.querySelectorAll<HTMLButtonElement>(BUTTONS)) {
    const { diff, body } = button.dataset
    const state = requests.get((diff ?? body)!)
    button.classList.toggle("busy", state === "busy")
    button.classList.toggle("failed", !!state && state !== "busy")
    button.title =
      state && state !== "busy" ? state : diff ? "Open in skepsis" : "Open the PR body"
  }
}

// A diff stat: the server starts skepsis on the diff, or shows the one
// already running. A PR's Body button: the server opens its body's doc page.
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(BUTTONS)
  if (!button) return
  // In a commit's line, the click shouldn't also open it
  e.preventDefault()
  const { diff, body } = button.dataset
  const key = (diff ?? body)!
  if (!threadUrl || requests.get(key) === "busy") return
  requests.set(key, "busy")
  paintButtons()
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
  if (error) requests.set(key, error)
  else requests.delete(key)
  paintButtons()
})

// A Push button: the server asks the user in a dialog, and pushes if they
// say so. The stack redraws by itself after, since the push is a jj
// operation.
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-push]")
  const bookmark = button?.dataset.push
  if (!bookmark || !threadUrl || pushes.get(bookmark) === "busy") return
  pushes.set(bookmark, "busy")
  redraw()
  let result: { how: "ok" | "bad" | "cancelled"; text: string }
  try {
    const res = await fetch(new URL("push", threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmark }),
    })
    if (res.ok) {
      const { pushed, output }: { pushed: boolean; output: string } = await res.json()
      result = { how: pushed ? "ok" : "cancelled", text: output }
    } else result = { how: "bad", text: (await res.text()) || `${res.status}` }
  } catch (e) {
    result = { how: "bad", text: String(e) }
  }
  pushes.set(bookmark, result)
  redraw()
})

// Named for the shape of Stack, so a tab never draws one from an older ah
const cacheKey = `ah-stack-rows:${location.pathname}`
const cached = read<Stack>(sessionStorage, cacheKey)
let current: Stack | null = cached
let currentError = ""
const redraw = () =>
  draw(current ?? { title: document.title, notes: [], trunk: "", rows: [] }, currentError)
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

let loading = false
let dirty = false

/** The stack, then GitHub's side, which takes longer. One load at a time;
 * asks during one make one more. */
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
        current = await get<Stack>("stack")
        currentError = ""
        write(sessionStorage, cacheKey, current)
      } catch (e) {
        currentError = (e as Error).message
      }
      redraw()
      await loadGithub()
    } while (dirty)
  } finally {
    loading = false
  }
}

if (threadUrl) {
  void load()
  // The server says when stack.json, a body or the repo's commits change
  document.addEventListener("ah-data", () => void load())
  setInterval(() => {
    if (document.visibilityState === "visible") void loadGithub()
  }, 60_000)
}
