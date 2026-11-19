/// <reference lib="dom" />

// A stack's page, served as /stack.js on the pages port; the page (file.ts)
// loads it and /stack.css. It draws the page's stack (data.ts, served at
// _ah/stack) newest first, like jj log: each PR's title, its tip, its files
// collapsed under it, and a line per commit that opens to its description
// and files. Commits below a fork that no PR's tip is on get a card of their
// own, shared by the PRs above. A graph down the left joins the commits, like
// jj log's. Each diff stat is a button that has the server open that diff in
// skepsis (skepsis.ts). A PR's Body button opens its body file in a doc page,
// starting the file if there isn't one.
//
// Beside what jj has, the page shows what GitHub has (github.ts, served at
// _ah/stack-github: a PR's link, state, checks, review, and GitHub stack)
// and what jj-spr says (spr.ts, served at _ah/stack-status: what `jj spr
// submit` would do for each PR, and the problems it would refuse on). Both
// come after the stack, since they're slow. A PR jj-spr has pushed before,
// whose commit as pushed is still here, has a bar under its newest commits
// marking the ones still to push, each tagged new or changed since then,
// with no tag for one only rebased. A PR that a push would change has a Push
// button on that bar, or one by its Body button before it's on GitHub. Push
// has the server run `jj spr submit --upto` the PR once the user confirms it
// in a sheet on the page's window, and jj-spr's output shows on the PR. When
// the push adds commits to an open PR, a field by its button has their
// message, which the server drafts with a quick model call (message.ts) and
// the user can change; left blank, it's Update. With more than one PR, Push
// all under the title pushes them all. Outside ah's
// window, as in a browser tab, there's no sheet to confirm in, so the
// buttons say so.
//
// The stack is read again, without a reload, when the server says its data
// changed: on every jj operation, and when the stack file or a body is
// saved. Which sections are open is kept across reloads and redraws, and
// after a reload the last stack is drawn at once while the new one loads.
// Any PR's card folds to one line: its title, its state on GitHub and its
// diff stat. A merged one starts folded, and the user's own choice wins and
// is kept. GitHub's side from the last load is kept too, so neither waits on
// gh after a reload.

import type { Changes, Commit, FileStat, Group, Pr, Shared, Stack } from "./data.ts"
import type { GithubPr, GithubPrs } from "./github.ts"
import type { SprCommand, SprEntry, SprStatus } from "./spr.ts"
import { escapeHtml } from "../escape.ts"
import { arrangeRows, isCollapsed, isTodo } from "./layout.ts"

const threadUrl = (() => {
  const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")
  return script?.dataset.ahThread ? new URL(script.dataset.ahThread, location.href) : null
})()

const main = document.querySelector("main")!
/** The page's own title, for a stack file with none */
const pageTitle = document.title

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

/** The PR's link on GitHub, with its state, and while it's open, its
 * checks and review */
function githubLead(gh: GithubPr): string {
  const state = gh.state === "OPEN" && gh.isDraft ? "draft" : gh.state.toLowerCase()
  const lead = [
    `<a class="gh-pr ${state}" href="${escapeHtml(gh.url)}" target="_blank" rel="noreferrer">#${gh.number} ${STATES[state as keyof typeof STATES]}</a>`,
  ]
  if (gh.state !== "OPEN") return lead.join("")
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
  return lead.join("")
}

/** How a run of jj-spr from the page ended: whether it worked, and its
 * output */
type RunResult = { ok: boolean; text: string }

/** Runs of jj-spr from this page, by the tip of the PR they were clicked on,
 * or ALL for the buttons under the title: the command while it's out, or
 * how it ended, which shows until the user dismisses it or another is
 * clicked there. One cancelled in the sheet leaves nothing. */
const runs = new Map<string, SprCommand | RunResult>()
const ALL = "*"
const running = (key: string) => typeof runs.get(key) === "string"

/** In ah's own window, whose sheet a run is confirmed in */
const inWindow = new URLSearchParams(location.search).get("in") === "window"

/** What jj-spr says of the PR with `tip`, once it has answered */
const statusOf = (tip: string): SprEntry | undefined =>
  status?.entries.find((e) => e.tip === tip)

/** Whether a push would do something for `pr`: what jj-spr says it would,
 * or until it answers, whether it isn't on GitHub yet or has commits still
 * to push */
function needsPush(pr: Pr): boolean {
  if (pr.merged) return false
  const actions = statusOf(pr.tip)?.actions
  if (actions) return actions.some(isTodo)
  return pr.pr === null ? pr.commits.length > 0 : pr.unpushed > 0
}

const RUNNING = { submit: "Pushing…", land: "Landing…", sync: "Syncing…" }

/** A button that runs `command` for `key`, a PR's tip or ALL, disabled
 * while a run for `key` is out */
function sprButton(command: SprCommand, key: string, label: string, title: string): string {
  const out = runs.get(key)
  const [text, tooltip] = !inWindow
    ? [
        `${label} in ah's window`,
        "jj spr runs are confirmed in ah's window for this page: open it with ah tool stack",
      ]
    : out === command
      ? [RUNNING[command], "Waiting for you to confirm in the window's sheet, then running"]
      : [label, `${title}, once you confirm in the window`]
  return `<button type="button" class="push-button${inWindow ? "" : " elsewhere"}" data-run="${command}" data-for="${escapeHtml(key)}" title="${escapeHtml(tooltip)}"${running(key) || !inWindow ? " disabled" : ""}>${text}</button>`
}

/** The Push button for one PR, which pushes the ones below it too */
const prPushButton = (pr: Pr) =>
  sprButton(
    "submit",
    pr.tip,
    pr.pr === null ? "Push and create PR" : "Push",
    `jj spr submit --upto ${pr.tip}: push this PR and the ones below it`,
  )

/** Whether the PRs up to the `n`th are open on GitHub with nothing to
 * push, so jj spr land can land them */
const landable = (n: number) =>
  prRows
    .filter((p) => p.n <= n && !p.merged)
    .every((p) => statusOf(p.tip)?.state === "open" && !needsPush(p))

/** How the last run from here for `key` went, if there was one */
function runResult(key: string): string {
  const result = runs.get(key)
  if (!result || typeof result === "string") return ""
  return `<div class="push-log">
      <button type="button" class="dismiss" data-dismiss="${escapeHtml(key)}" title="Dismiss" aria-label="Dismiss">×</button>
      <pre class="push-result ${result.ok ? "ok" : "bad"}">${escapeHtml(result.text)}</pre>
    </div>`
}

/** jj-spr's problems with `tips`, or with the whole file for null */
const problems = (tip: string | null) =>
  (status?.problems ?? [])
    .filter((p) => p.tip === tip)
    .map((p) => `<pre class="problem">${escapeHtml(p.message)}</pre>`)
    .join("")

/** How a commit still to push differs from what jj-spr last pushed: new,
 * only rebased, or changed */
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

/** A commit's tag for how it differs from what was pushed, with none for
 * one only rebased, since there's nothing in it to look at */
function pushTag(c: Commit): string {
  const kind = pushKind(c)
  if (kind === "new") return '<span class="push-tag" title="Not pushed yet">new</span>'
  if (kind === "rebased") return ""
  const { from, ...changes } = c.rewrite!
  return changedTag({ from, to: c.commit }, changes, "Open what changed in skepsis")
}

/** A PR's tag for how its commits differ from what was pushed, apart from
 * moving onto new parents. A new commit's description makes the interdiff's
 * descriptions differ, so it's only "reworded" when no lines changed. */
function prTag({ from, to, add, del, reworded }: NonNullable<Pr["interdiff"]>): string {
  if (!add && !del && !reworded) return ""
  return changedTag(
    { from, to },
    { add, del, reworded: reworded && !add && !del },
    "Open what changed in the PR since the last push in skepsis",
  )
}

/** The bar's text for `pr`: how many commits to push, and how many are new
 * or changed unless all are new, the rest only rebased; or with none known,
 * what jj-spr would do */
function toPushText(pr: Pr): string {
  const kinds = pr.commits.slice(0, pr.unpushed).map(pushKind)
  if (!kinds.length)
    return statusOf(pr.tip)?.actions?.includes("push the changes")
      ? "↑ changes to push"
      : "↑ to update on GitHub"
  const count = (k: string) => kinds.filter((x) => x === k).length
  if (count("new") === kinds.length) return `↑ ${kinds.length} to push`
  if (count("rebased") === kinds.length) return `↑ ${kinds.length} to push, unchanged`
  const parts = (["new", "changed"] as const)
    .filter((k) => count(k))
    .map((k) => `${count(k)} ${k}`)
  return `↑ ${kinds.length} to push: ${parts.join(", ")}`
}

/** The bar for a PR on GitHub with something to push, or nothing */
function pushBar(pr: Pr): string {
  if (pr.pr === null || !needsPush(pr)) return ""
  const below = pr.pushed && pr.unpushed < pr.commits.length
  return `<span>${toPushText(pr)}</span>${messageField(pr.n, pr.tip)}${prPushButton(pr)}${below ? '<span class="pushed">pushed ↓</span>' : ""}`
}

/** The stack's PRs as last drawn, for what a push sends */
let prRows: Pr[] = []
/** Drafts of the update message, by what they're drafted from (draftKey),
 * null while asked for */
const drafts = new Map<string, string | null>()
/** What the user typed in a message field, by the same key, so a redraw
 * keeps it, and a new draft for new edits replaces it */
const typed = new Map<string, string>()

/** The message field for a push of the PRs up to the `n`th, by Push
 * button `key`, when the push adds commits to an open PR: blank until a
 * draft comes, which the server asks a model for, and Update when it's
 * left blank */
function messageField(n: number, key: string): string {
  const updates = prRows.filter(
    (p) =>
      p.n <= n &&
      p.pr !== null &&
      !p.merged &&
      (p.unpushed > 0 || !!statusOf(p.tip)?.actions?.includes("push the changes")),
  )
  if (!updates.length) return ""
  // Each changed PR's pushed commit and its tip's now, as the server keeps
  // drafts; without any, there's nothing to draft from
  const from = updates
    .filter((p) => p.unpushed)
    .map((p) => `${p.pushed}:${p.commits[0].commit}`)
    .join(" ")
  if (from && !drafts.has(from)) void askDraft(from, key)
  const value = typed.get(from) ?? drafts.get(from) ?? ""
  return `<input type="text" class="push-message" data-message="${escapeHtml(from)}" data-for="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="Update" aria-label="Message for the commits that update open PRs" title="Message for the commits that update open PRs">`
}

/** Ask the server for a draft of the message for Push button `key`'s
 * push, made from `from` */
async function askDraft(from: string, key: string) {
  drafts.set(from, null)
  let message = ""
  try {
    const res = await fetch(new URL("push-message", threadUrl!), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tip: key === ALL ? null : key }),
    })
    if (res.ok) message = ((await res.json()) as { message: string }).message
  } catch {
    // The field stays blank, and the push says Update
  }
  drafts.set(from, message)
  redraw()
}

/** The commits, with `bar` under the first `unpushed` of them, the newest,
 * when there is one. Unless those are all new, each says how it differs
 * from what was pushed. */
function commitList(commits: Commit[], unpushed = 0, bar = ""): string {
  const toPush = commits.slice(0, unpushed)
  const tagged = toPush.some((c) => c.rewrite)
  const items = commits.map((c, i) => {
    const [title, ...rest] = c.description.split("\n")
    const body = rest.join("\n").trim()
    const tag = tagged && i < unpushed
    return `<li><details class="commit" ${openAttr(`c-${c.change}`)}>
      <summary>
        <span class="mono cid" title="${c.change} @ ${c.commit.slice(0, 8)}">${escapeHtml(c.short)}</span>
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
  if (bar) items.splice(unpushed, 0, `<li class="to-push">${bar}</li>`)
  return `<ol class="commits">${items.join("")}</ol>`
}

// Lucide's chevron-right, turned down when the card is open
const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`

/** What submit would do for `pr` that its buttons and bar don't say */
function plannedNote(pr: Pr): string {
  const said = ["push the changes", "open a Pull Request"]
  const rest = (statusOf(pr.tip)?.actions ?? []).filter(
    (a) => !a.startsWith("nothing") && !said.includes(a),
  )
  return rest.length ? note(`jj spr submit will ${rest.join(", ")}`, "warn") : ""
}

function prCard(pr: Pr, gh: GithubPr | undefined): string {
  const files = pr.files.length
  // Like a merged PR whose commits left the stack: nothing to unfold
  const empty = !files && !pr.commits.length
  const collapsed = empty || isCollapsed(folds[pr.tip], pr, gh)
  const title = escapeHtml(pr.title || statusOf(pr.tip)?.title || "(no title)")
  // A dot on the graph for its commits, which aren't drawn, or for a merged
  // PR whose commits have left the stack, so it still has its place on the line
  const dot = collapsed ? " dot" : ""
  const fold = empty
    ? ""
    : `<button type="button" class="fold" data-fold="${escapeHtml(pr.tip)}" aria-expanded="${!collapsed}" title="${collapsed ? "Show" : "Fold"} this PR">${CHEVRON}</button>`
  const head = `<div class="pr-head${dot}">
      ${fold}
      <h2><span class="n">${pr.n}.</span> ${title}</h2>
      ${pr.interdiff ? prTag(pr.interdiff) : ""}
      ${pr.diff ? stat(pr.files, pr.diff) : ""}
    </div>`
  const body = pr.body
    ? `<button type="button" class="body-button" data-body="${escapeHtml(pr.tip)}" data-title="Open ${escapeHtml(pr.body)}">${PENCIL} Body</button>`
    : ""
  // Before it's on GitHub, the button goes by Body, with a message field
  // if the push updates open PRs below it
  const fresh =
    pr.pr === null && needsPush(pr) ? messageField(pr.n, pr.tip) + prPushButton(pr) : ""
  const stack = gh?.stack
    ? note(
        `stack #${gh.stack.number}`,
        "",
        `In GitHub stack #${gh.stack.number}, ${gh.stack.position} of ${gh.stack.size} from the bottom, counting merged PRs`,
      )
    : ""
  const merged = pr.merged && !gh ? note("merged", "good") : ""
  const land =
    !pr.merged && landable(pr.n)
      ? sprButton(
          "land",
          pr.tip,
          "Land",
          `jj spr land --upto ${pr.tip}: squash-merge this PR and the ones below it`,
        )
      : ""
  const meta = `<div class="pr-meta">${gh ? githubLead(gh) : ""}${body}${fresh}${land}<span class="mono">${escapeHtml(pr.tip)}</span>${merged}${stack}${plannedNote(pr)}</div>
    ${problems(pr.tip)}${runResult(pr.tip)}`
  const bar = pushBar(pr)
  // Folded, the bar for its commits still to push stands in for them
  if (collapsed)
    return `<section class="pr collapsed">${head}${meta}${bar ? `<div class="to-push">${bar}</div>` : ""}</section>`
  return `<section class="pr">
    ${head}
    ${meta}
    ${
      files
        ? `<details class="more" ${openAttr(`pr-${pr.tip}`)}>
      <summary>${files} file${files === 1 ? "" : "s"}</summary>
      ${fileList(pr.files)}
    </details>`
        : ""
    }
    ${commitList(pr.commits, pr.unpushed, bar)}
  </section>`
}

/** Commits below a fork with no PR's tip on them, so each PR above would
 * include them on GitHub */
function sharedCard(group: Shared): string {
  const { prs } = group
  const named = group.head !== group.commits[0].change
  return `<section class="pr shared">
    <div class="pr-head">
      <h2>${named ? `<span class="mono">${escapeHtml(group.head)}</span>` : "No bookmark"}</h2>
      ${group.diff ? stat(group.files, group.diff) : ""}
    </div>
    <div class="pr-meta">${note(`shared by PRs ${prs.slice(0, -1).join(", ")} and ${prs.at(-1)}`, "warn")}</div>
    ${commitList(group.commits)}
  </section>`
}

/** The buttons for the whole stack: with more than one PR, Push all when
 * any would change and Land all when all can land; and Sync once any has
 * merged on GitHub that the file doesn't say has */
function stackBar(prs: Pr[]): string {
  const live = prs.filter((pr) => !pr.merged)
  const several = live.length > 1
  const buttons = [
    several && live.some(needsPush)
      ? messageField(Infinity, ALL) +
        sprButton("submit", ALL, "Push all", "jj spr submit: push every PR in the stack")
      : "",
    several && landable(Infinity)
      ? sprButton(
          "land",
          ALL,
          "Land all",
          "jj spr land: squash-merge every PR, bottom first",
        )
      : "",
    // Merged on GitHub, but not yet in the file
    live.some((pr) => statusOf(pr.tip)?.state === "merged")
      ? sprButton(
          "sync",
          ALL,
          "Sync",
          "jj spr sync: abandon the merged changes, rebase the rest onto trunk, and mark those PRs merged",
        )
      : "",
  ].join("")
  return (buttons ? `<div class="stack-actions">${buttons}</div>` : "") + runResult(ALL)
}

// In localStorage, so a new window knows which PRs merged before gh answers
const githubKey = `ah-stack-github:${location.pathname}`
let github = read<GithubPrs>(localStorage, githubKey) ?? {}
/** By tip, whether the user folded the PR (true) or opened it */
const foldsKey = `ah-stack-folds:${location.pathname}`
const folds = read<Record<string, boolean>>(localStorage, foldsKey) ?? {}
let githubError = ""
let status: SprStatus | null = null
let statusError = ""
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
  const title = stack.title || pageTitle
  document.title = title
  const rows = arrangeRows(stack.rows, github)
  const prs = (prRows = rows.filter((r): r is Pr => "n" in r))
  const lanes = graphLanes(rows)
  // Problems with tips no entry has, as after a tip was renamed
  const stray = (status?.problems ?? []).filter(
    (p) => p.tip !== null && !prs.some((pr) => pr.tip === p.tip),
  )
  const html = `
    <h1>${escapeHtml(title)}</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${githubError ? `<p class="error">GitHub: ${escapeHtml(githubError)}</p>` : ""}
    ${statusError ? `<p class="error">jj spr: ${escapeHtml(statusError)}</p>` : ""}
    ${problems(null)}${stray.map((p) => `<pre class="problem">${escapeHtml(p.message)}</pre>`).join("")}
    <div class="notes">${stack.notes.map((n) => `<p>${prose(n)}</p>`).join("")}</div>
    ${stackBar(prs)}
    ${
      rows.length
        ? `<div class="prs"><svg class="graph"></svg>${rows
            .map((row, i) => {
              const { lane, join } = lanes[i]
              return `<div class="row" style="--lane: ${lane}" data-lane="${lane}"${join === null ? "" : ` data-join="${join}"`}>${"n" in row ? prCard(row, github[row.tip]) : sharedCard(row)}</div>`
            })
            .join(
              "",
            )}<div class="trunk mono">${escapeHtml(rows.findLast((r) => r.commits.length)?.base ?? "")}</div></div>`
        : `<p class="empty">No PRs in stack.json yet</p>`
    }`
  if (html === drawn) return
  // A message field being typed in keeps its focus and caret
  const typing = document.activeElement
  const field = typing instanceof HTMLInputElement ? typing.dataset.for : undefined
  const caret = typing instanceof HTMLInputElement ? typing.selectionStart : null
  main.innerHTML = drawn = html
  if (field !== undefined) {
    const input = main.querySelector<HTMLInputElement>(
      `input[data-for="${CSS.escape(field)}"]`,
    )
    input?.focus()
    input?.setSelectionRange(caret, caret)
  }
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
      body: diff ?? JSON.stringify({ tip: body }),
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
  const tip = (e.target as Element).closest<HTMLElement>("button[data-fold]")?.dataset.fold
  const pr = current?.rows.find((r): r is Pr => "n" in r && r.tip === tip)
  if (!tip || !pr) return
  folds[tip] = !isCollapsed(folds[tip], pr, github[tip])
  write(localStorage, foldsKey, folds)
  redraw()
})

// A Push, Land or Sync button: the server asks the user in a sheet, and
// runs jj-spr if they say so. The stack redraws by itself after, since
// jj-spr writes the stack file.
main.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-run]")
  const command = button?.dataset.run as SprCommand | undefined
  const key = button?.dataset.for
  if (!command || key === undefined || !threadUrl || running(key)) return
  const message =
    main.querySelector<HTMLInputElement>(`input[data-for="${CSS.escape(key)}"]`)?.value ??
    ""
  runs.set(key, command)
  redraw()
  let result: RunResult | null
  try {
    const res = await fetch(new URL("spr", threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command,
        tip: key === ALL ? null : key,
        message: message.trim(),
      }),
    })
    if (res.ok) {
      const { done, output }: { done: boolean; output: string } = await res.json()
      result = done ? { ok: true, text: output } : null
    } else result = { ok: false, text: (await res.text()) || `${res.status}` }
  } catch (e) {
    result = { ok: false, text: String(e) }
  }
  if (result) runs.set(key, result)
  else runs.delete(key)
  redraw()
  void loadRemote()
})

// A message field: what's typed is kept for redraws, and Enter pushes
main.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement
  if (input.dataset.message !== undefined) typed.set(input.dataset.message, input.value)
})
main.addEventListener("keydown", (e) => {
  const key = e.target instanceof HTMLInputElement ? e.target.dataset.for : undefined
  if (e.key !== "Enter" || key === undefined) return
  main
    .querySelector<HTMLButtonElement>(
      `button[data-run="submit"][data-for="${CSS.escape(key)}"]`,
    )
    ?.click()
})

// A run's log, which the user is done with
main.addEventListener("click", (e) => {
  const key = (e.target as Element).closest<HTMLElement>("button[data-dismiss]")?.dataset
    .dismiss
  if (!key || running(key)) return
  runs.delete(key)
  redraw()
})

// Named for the shape of Stack, so a tab never draws one from an older ah
const cacheKey = `ah-stack-rows-spr:${location.pathname}`
const cached = read<Stack>(sessionStorage, cacheKey)
let current: Stack | null = cached
let currentError = ""
const redraw = () => draw(current ?? { title: "", notes: [], rows: [] }, currentError)
if (cached) redraw()

async function get<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, threadUrl!), { cache: "no-store" })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as T
}

/** GitHub's side and jj-spr's, which nothing here hears change on GitHub,
 * so asked for again now and then while the page is in view. Not jj-spr's
 * while a run from here is going: halfway through, as after a PR opens but
 * before the stack file has its number, status refuses on the stack. The
 * run asks again when it ends. */
async function loadRemote() {
  const sprRunning = [...runs.keys()].some(running)
  await Promise.all([
    get<GithubPrs>("stack-github").then(
      (prs) => {
        github = prs
        githubError = ""
        write(localStorage, githubKey, github)
      },
      (e: Error) => (githubError = e.message),
    ),
    sprRunning ||
      get<SprStatus>("stack-status").then(
        (s) => {
          status = s
          statusError = ""
        },
        (e: Error) => (statusError = e.message),
      ),
  ])
  redraw()
}

let loading = false
let dirty = false

/** The stack, then GitHub's and jj-spr's side, which take longer. One load
 * at a time; asks during one make one more. */
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
      await loadRemote()
    } while (dirty)
  } finally {
    loading = false
  }
}

if (threadUrl) {
  void load()
  // The server says when the stack file, a body or the repo's commits change
  document.addEventListener("ah-data", () => void load())
  setInterval(() => {
    if (document.visibilityState === "visible") void loadRemote()
  }, 60_000)
}
