/// <reference lib="dom" />

// A stack's page, served as /stack.js on the pages port; the page (file.ts)
// loads it and /stack.css. It draws the page's stack (data.ts, served
// at _ah/stack) newest first, like jj log: each PR's title, its bookmark and
// how it merges, its files collapsed under it, and a line per
// commit that opens to its description and files. Once a PR is pushed, a line
// under its newest commits marks the ones still to push, with a Push button
// on it, and each of those says whether it's new or changed since the remote's
// version, with no tag for one only rebased, as when a PR below gained a commit; a PR whose bookmark isn't on the remote yet has its Push button by
// its Body button. Push has the server push the bookmark once the user
// confirms it in a sheet on the page's window (push.ts), and jj's answer
// shows on the PR. For a bookmark not on the remote yet, the button says
// "Push and create PR", and the server opens its PR after the push, whose
// link then shows with jj's answer. Outside ah's window, as in a browser tab, there's no
// sheet to confirm in, so the button says so. Commits below a fork
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
//
// Any PR's card folds to one line: its title, its state on GitHub and its
// diff stat. A merged one starts folded, and the user's own choice wins and
// is kept. A PR whose bookmark is gone but which GitHub has merged or closed
// goes with the PRs with no commits of their own (layout.ts). GitHub's side
// from the last load is kept too, so neither waits on gh after a reload.

import type { Changes, Commit, FileStat, Group, Pr, Shared, Stack } from "./data.ts"
import type { GithubPr, GithubPrs } from "./github.ts"
import { escapeHtml } from "../escape.ts"
import {
  arrangeRows,
  doneOnGithub,
  isCollapsed,
  prBelow,
  type RunResult,
  settledRuns,
} from "./layout.ts"

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

/** The PR's link on GitHub, with its state */
function githubLink(gh: GithubPr): string {
  const state = gh.state === "OPEN" && gh.isDraft ? "draft" : gh.state.toLowerCase()
  return `<a class="gh-pr ${state}" href="${escapeHtml(gh.url)}" target="_blank" rel="noreferrer">#${gh.number} ${STATES[state as keyof typeof STATES]}</a>`
}

/** The PR's link and where it stands on GitHub, with what doesn't match
 * here: its head, saying which side moved, and its base, which should be the
 * PR below it or trunk. The link, checks, and review lead the meta line, and
 * the rest follows the bookmark. */
function githubMeta(pr: Pr, gh: GithubPr, base: string): [string, string] {
  const link = githubLink(gh)
  if (gh.state !== "OPEN") return [link, ""]
  const lead = [link]
  if (gh.checks) {
    const title = CHECKS[gh.checks]
    lead.push(
      `<a class="gh-checks ${gh.checks}" href="${escapeHtml(gh.url)}/checks" target="_blank" rel="noreferrer" title="${title}" aria-label="${title}"></a>`,
    )
  }
  const review = REVIEWS[gh.reviewDecision]
  if (review) {
    const [text, cls, icon] = review
    lead.push(
      `<span class="gh-note gh-review ${cls}" title="Review on GitHub: ${text}"><svg viewBox="0 0 24 24" aria-label="${text}">${icon}</svg></span>`,
    )
  }
  const notes: string[] = []
  // From a cache an older ah wrote, it has no stack
  if (gh.stack) {
    const { number, size, position } = gh.stack
    notes.push(
      note(
        `stack #${number}`,
        "",
        `In GitHub stack #${number}, ${position} of ${size} from the bottom, counting merged PRs`,
      ),
    )
  }
  const tip = pr.commits[0]?.commit
  const head = gh.headRefOid
  if (tip && !head.startsWith(tip)) {
    const where = `${tip} here, ${head.slice(0, 8)} on GitHub`
    // Pushed as it was last fetched, so the change is here, and the line in
    // the commit list shows it unless the bookmark only moved back. Otherwise
    // GitHub has something newer, like a rebase after the PR below merged.
    // Whether it's new commits or a rewrite can't be told until a fetch
    // brings its head, and then the commit list shows which.
    if (!pr.pushed || !head.startsWith(pr.pushed))
      notes.push(
        note("GitHub's branch moved since the last fetch", "warn", where),
        fetchButton(pr),
      )
    else if (!pr.unpushed) notes.push(note("not pushed", "warn", where))
  }
  if (base && gh.baseRefName !== base)
    notes.push(note(`base is ${gh.baseRefName} on GitHub, ${base} here`, "warn"))
  return [lead.join(""), notes.join("")]
}

/** Pushes and fetches from this page, by the bookmark of the PR they were
 * clicked on: out, or how they ended, which shows on the PR until GitHub's
 * side shows the PR after it (settledRuns), the user dismisses it, or another
 * is clicked there */
const runs = new Map<string, "pushing" | "fetching" | RunResult>()
const running = (bookmark: string) => typeof runs.get(bookmark) === "string"

/** In ah's own window, whose sheet a push is confirmed in */
const inWindow = new URLSearchParams(location.search).get("in") === "window"

/** The Push button for `pr`, disabled while its push is out; for a bookmark
 * that's `fresh` on the remote, it creates the PR too */
function pushButton(pr: Pr, fresh = false): string {
  const busy = runs.get(pr.bookmark) === "pushing"
  const [label, title] = !inWindow
    ? [
        "Push in ah's window",
        "Pushing is confirmed in ah's window for this page: open it with ah tool stack",
      ]
    : busy
      ? ["Pushing…", "Waiting for you to confirm in the window's sheet, then pushing"]
      : fresh
        ? [
            "Push and create PR",
            `Push ${pr.bookmark} and open its PR, after the window asks you`,
          ]
        : pr.rewrites
          ? [
              "Force push",
              `Push ${pr.bookmark}, rewriting what's pushed, after the window asks you`,
            ]
          : ["Push", `Push ${pr.bookmark}, after the window asks you`]
  return `<button type="button" class="push-button${inWindow ? "" : " elsewhere"}" data-push="${escapeHtml(pr.bookmark)}" title="${escapeHtml(title)}"${running(pr.bookmark) || !inWindow ? " disabled" : ""}>${label}</button>`
}

/** The Fetch button by a note that GitHub has `pr`'s branch somewhere the
 * last fetch didn't bring */
function fetchButton(pr: Pr): string {
  const busy = runs.get(pr.bookmark) === "fetching"
  return `<button type="button" class="push-button" data-fetch="${escapeHtml(pr.bookmark)}" title="jj git fetch, which sends nothing"${running(pr.bookmark) ? " disabled" : ""}>${busy ? "Fetching…" : "Fetch"}</button>`
}

/** How the PR's last push or fetch from this page went, if there was one */
function runResult(pr: Pr): string {
  const result = runs.get(pr.bookmark)
  if (!result || typeof result === "string") return ""
  const opened = result.pr
    ? `<p class="push-pr">Opened <a href="${escapeHtml(result.pr)}" target="_blank" rel="noopener">${escapeHtml(result.pr)}</a></p>`
    : result.prError
      ? `<pre class="push-result bad">The PR didn't open, so it's still to create: ${escapeHtml(result.prError)}</pre>`
      : ""
  const stacked = result.stackError
    ? `<pre class="push-result bad">${escapeHtml(result.stackError)}</pre>`
    : result.stack
      ? `<p class="push-pr">${escapeHtml(result.stack)}</p>`
      : ""
  return `<div class="push-log">
      <button type="button" class="dismiss" data-dismiss="${escapeHtml(pr.bookmark)}" title="Dismiss" aria-label="Dismiss">×</button>
      <pre class="push-result ${result.how}">${escapeHtml(result.text)}</pre>${opened}${stacked}
    </div>`
}

/** How a commit still to push differs from what the remote has: new, only
 * rebased, or changed */
function pushKind(c: Commit): "new" | "rebased" | "changed" {
  const r = c.rewrite
  return !r ? "new" : r.add || r.del || r.reworded ? "changed" : "rebased"
}

/** A button that opens an interdiff in skepsis, with its line counts on a
 * segment of their own */
function changedTag(
  diff: { from: string; to: string },
  { add, del, reworded }: Changes,
  title: string,
): string {
  const text = [add || del ? "changed" : "", reworded ? "reworded" : ""]
    .filter(Boolean)
    .join(", ")
  const lines = add || del ? `<span class="mono">${counts(add, del)}</span>` : ""
  const data = escapeHtml(JSON.stringify({ ...diff, interdiff: true }))
  return `<button type="button" class="push-tag changed" data-diff="${data}" data-title="${title}">${text}${lines}</button>`
}

/** A commit's tag for how it differs from what the remote has, with none
 * for one only rebased, since there's nothing in it to look at */
function pushTag(c: Commit): string {
  const kind = pushKind(c)
  if (kind === "new")
    return '<span class="push-tag" title="Not on the remote yet">new</span>'
  if (kind === "rebased") return ""
  const { from, ...changes } = c.rewrite!
  return changedTag({ from, to: c.commit }, changes, "Open what changed in skepsis")
}

/** A PR's tag for how its commits differ from the remote's, apart from moving
 * onto new parents. A new commit's description makes the interdiff's
 * descriptions differ, so it's only "reworded" when no lines changed. */
function prTag({ from, to, add, del, reworded }: NonNullable<Pr["interdiff"]>): string {
  if (!add && !del && !reworded) return ""
  return changedTag(
    { from, to },
    { add, del, reworded: reworded && !add && !del },
    "Open what changed in the PR since the last push in skepsis",
  )
}

/** The bar's text: how many to push, and how many are new or changed
 * unless all are new. The rest were only rebased. */
function toPushText(commits: Commit[]): string {
  const kinds = commits.map(pushKind)
  const count = (k: string) => kinds.filter((x) => x === k).length
  if (count("new") === kinds.length) return `↑ ${kinds.length} to push`
  if (count("rebased") === kinds.length) return `↑ ${kinds.length} to push, unchanged`
  const parts = (["new", "changed"] as const)
    .filter((k) => count(k))
    .map((k) => `${count(k)} ${k}`)
  return `↑ ${kinds.length} to push: ${parts.join(", ")}`
}

/** The commits, with a line under the first `unpushed` of them, the newest,
 * when there are any, with `button` on it. Unless those are all new, each
 * says how it differs from what the remote has. */
function commitList(commits: Commit[], unpushed = 0, button = ""): string {
  const toPush = commits.slice(0, unpushed)
  const tagged = toPush.some((c) => c.rewrite)
  const items = commits.map((c, i) => {
    const [title, ...rest] = c.description.split("\n")
    const body = rest.join("\n").trim()
    const tag = tagged && i < unpushed
    return `<li><details class="commit" ${openAttr(`c-${c.change}`)}>
      <summary>
        <span class="mono cid" title="${c.change} @ ${c.commit}">${escapeHtml(c.short)}</span>
        <span class="title">${escapeHtml(title || "(no description)")}</span>
        ${tag ? pushTag(c) : ""}
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
      `<li class="to-push"><span>${toPushText(toPush)}</span>${button}${unpushed < commits.length ? '<span class="pushed">pushed ↓</span>' : ""}</li>`,
    )
  return `<ol class="commits">${items.join("")}</ol>`
}

// Lucide's chevron-right, turned down when the card is open
const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`

function prCard(pr: Pr, gh: GithubPr | undefined, base: string): string {
  const collapsed = isCollapsed(folds[pr.bookmark], gh)
  const title = escapeHtml(gh?.title ?? pr.title)
  // A dot on the graph for its commits, which aren't drawn
  const dot = collapsed && pr.commits.length ? " dot" : ""
  const head = `<div class="pr-head${dot}">
      <button type="button" class="fold" data-fold="${escapeHtml(pr.bookmark)}" aria-expanded="${!collapsed}" title="${collapsed ? "Show" : "Fold"} this PR">${CHEVRON}</button>
      <h2><span class="n">${pr.n}.</span> ${title}</h2>
      ${pr.interdiff ? prTag(pr.interdiff) : ""}
      ${pr.diff ? stat(pr.files, pr.diff) : ""}
    </div>`
  // Before a first push, all of them are to push, which goes without saying
  const unpushed = pr.pushed ? pr.unpushed : 0
  // Its bookmark is new on the remote, so the button goes by Body
  const fresh = !pr.pushed && pr.commits.length > 0
  const files = pr.files.length
  const [ghLead, ghNotes] = gh ? githubMeta(pr, gh, base) : ["", ""]
  const meta = `<div class="pr-meta">${ghLead}${gh ? "" : `<button type="button" class="body-button" data-body="${escapeHtml(pr.bookmark)}" title="Open the PR body">${PENCIL} Body</button>`}${fresh ? pushButton(pr, true) : ""}<span><span class="mono">${escapeHtml(pr.bookmark)}</span>${pr.merge ? ` · ${escapeHtml(pr.merge)}` : ""}</span>${pr.missing && !doneOnGithub(gh) ? note("no bookmark yet", "warn") : ""}${ghNotes}</div>
    ${runResult(pr)}`
  if (collapsed) return `<section class="pr collapsed">${head}${meta}</section>`
  return `<section class="pr">
    ${head}
    ${meta}
    ${
      files
        ? `<details class="more" ${openAttr(`pr-${pr.bookmark}`)}>
      <summary>${files} file${files === 1 ? "" : "s"}</summary>
      ${fileList(pr.files)}
    </details>`
        : ""
    }
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

// In localStorage, so a new window knows which PRs merged before gh answers
const githubKey = `ah-stack-github:${location.pathname}`
let github = read<GithubPrs>(localStorage, githubKey) ?? {}
/** By bookmark, whether the user folded the PR (true) or opened it */
const foldsKey = `ah-stack-folds:${location.pathname}`
const folds = read<Record<string, boolean>>(localStorage, foldsKey) ?? {}
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
  const rows = arrangeRows(stack.rows, github)
  const lanes = graphLanes(rows)
  // On GitHub, the PR below it, or trunk once that one has merged, since
  // GitHub then retargets this one
  const base = (pr: Pr) => {
    const below = prBelow(rows, pr)
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
    // A folded card's commits as one dot, by its title
    const ys = [...row.querySelectorAll(".commit > summary, .pr-head.dot")].map(mid)
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
      state && state !== "busy"
        ? state
        : (button.dataset.title ?? (diff ? "Open in skepsis" : "Open the PR body"))
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

// A PR's fold button, whose choice is kept over the default
main.addEventListener("click", (e) => {
  const bookmark = (e.target as Element).closest<HTMLElement>("button[data-fold]")?.dataset
    .fold
  if (!bookmark) return
  folds[bookmark] = !isCollapsed(folds[bookmark], github[bookmark])
  write(localStorage, foldsKey, folds)
  redraw()
})

// A Push or Fetch button. For Push, the server asks the user in a sheet,
// and pushes if they say so. The stack redraws by itself after either, since
// both are jj operations.
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(
    "button[data-push], button[data-fetch]",
  )
  const fetching = button?.dataset.fetch !== undefined
  const bookmark = button?.dataset.push ?? button?.dataset.fetch
  if (!bookmark || !threadUrl || running(bookmark)) return
  runs.set(bookmark, fetching ? "fetching" : "pushing")
  redraw()
  let result: Omit<RunResult, "at">
  try {
    const res = await fetch(new URL(fetching ? "fetch" : "push", threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmark }),
    })
    if (res.ok) {
      // A fetch answers only its output
      const {
        pushed = true,
        output,
        ...rest
      }: { pushed?: boolean; output: string } & Pick<
        RunResult,
        "pr" | "prError" | "stack" | "stackError"
      > = await res.json()
      result = { how: pushed ? "ok" : "cancelled", text: output, ...rest }
    } else result = { how: "bad", text: (await res.text()) || `${res.status}` }
  } catch (e) {
    result = { how: "bad", text: String(e) }
  }
  runs.set(bookmark, { ...result, at: Date.now() })
  redraw()
  // GitHub has the branch's new head now, and maybe a new PR, which then
  // shows in place of the Body and Push buttons, and the log goes
  if (result.how !== "bad") void loadGithub()
})

// A run's log, which the user is done with
main.addEventListener("click", (e) => {
  const bookmark = (e.target as Element).closest<HTMLElement>("button[data-dismiss]")
    ?.dataset.dismiss
  if (!bookmark || running(bookmark)) return
  runs.delete(bookmark)
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
  const asked = Date.now()
  try {
    github = await get<GithubPrs>("stack-github")
    githubError = ""
    write(localStorage, githubKey, github)
    for (const bookmark of settledRuns(runs, github, asked)) runs.delete(bookmark)
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
