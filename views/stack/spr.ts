// jj-spr, which owns the stack file and pushes its PRs (`jj spr`, run at the
// repo's root). Its status, for the page: what `submit` would do for each
// entry, and the problems it would refuse on. And the page's Push, Land and
// Sync buttons, served at the page's _ah/spr: a button only asks, and the
// server shows what jj-spr would do in a sheet on the page's window
// (platform/ask.ts), then runs it only once the person clicks there. A page
// with no window of ah's, like a browser tab, can't run one. One run at a
// time per repo, counting the time its sheet is up.

import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import type { Confirm, Question } from "../../platform/ask.ts"
import { isRecord } from "../../platform/guards.ts"
import { opHeadsDir, repoDir } from "../../platform/jj.ts"
import { type Output, run } from "../../platform/proc.ts"
import { parseStackFile, STACK_FILE } from "./data.ts"
import { forgetGithub } from "./github.ts"
import { isTodo } from "./layout.ts"

/** An entry as `jj spr stack-file status --json` has it. Only the first
 * three are there for an entry whose changes aren't known, as when its tip
 * doesn't resolve. */
export interface SprEntry {
  tip: string
  pr: number | null
  merged: boolean
  members?: { change_id: string; title: string }[]
  title?: string
  state?: "open" | "merged" | "closed"
  /** What submit would do: empty when that depends on how a problem is
   * fixed */
  actions?: string[]
}

export interface SprStatus {
  entries: SprEntry[]
  /** Each one submit would refuse on, by the tip it's about, or null for
   * the whole file */
  problems: { tip: string | null; message: string }[]
}

/** Running jj spr in `cwd`, which tests stand in for. Its stdin is closed,
 * so it can't wait on a prompt. */
export type SprRun = (cwd: string, ...args: string[]) => Promise<Output>

export const sprRun: SprRun = (cwd, ...args) =>
  run("jj", ["spr", ...args], { cwd, input: "" })

const TTL = 30_000
const statuses = new Map<string, { key: string; at: number; status: Promise<SprStatus> }>()

/** jj-spr's status for the stack file next to `pagePath`. Kept while the
 * file, its bodies and the repo's operations are as they were, for up to
 * TTL, since jj-spr asks GitHub too; `fresh` asks again regardless. */
export async function readStatus(
  pagePath: string,
  spr: SprRun,
  fresh = false,
): Promise<SprStatus> {
  const dir = dirname(pagePath)
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  const file = join(dir, STACK_FILE)
  const text = await readFile(file, "utf8")
  const bodies = parseStackFile(text).prs.map((e) =>
    e.body ? readFile(join(dir, e.body), "utf8").catch(() => "") : "",
  )
  const ops = (await readdir(await opHeadsDir(root))).join()
  const key = [ops, text, ...(await Promise.all(bodies))].join("\0")
  const hit = statuses.get(pagePath)
  if (!fresh && hit?.key === key && Date.now() - hit.at < TTL) return hit.status
  const status = spr(root, "stack-file", "status", file, "--json").then((out) => {
    // It exits nonzero with problems, and still prints them
    try {
      const status = JSON.parse(out.stdout) as SprStatus
      if (Array.isArray(status.entries)) return status
    } catch {
      // jj-spr failed outright, as without its config, and says why
    }
    throw new Error(out.stderr.trim() || "jj spr stack-file status failed")
  })
  statuses.set(pagePath, { key, at: Date.now(), status })
  // A failure shouldn't stick
  status.catch(() => statuses.delete(pagePath))
  return status
}

/** A run that won't happen, with why, as an HTTP status */
class Refused extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type SprCommand = "submit" | "land" | "sync"

/** What a page asks jj-spr to do: submit or land the PRs up to the one
 * with `tip`, or all of them with null, or sync the stack. `message` is
 * for the commits a submit adds to open PRs. */
export interface SprAsk {
  command: SprCommand
  tip: string | null
  message: string
}

const parseAsk = (body: unknown): SprAsk | null =>
  isRecord(body) &&
  (body.command === "submit" || body.command === "land" || body.command === "sync") &&
  (body.tip === null || typeof body.tip === "string") &&
  typeof body.message === "string"
    ? { command: body.command, tip: body.tip, message: body.message }
    : null

/** The message for update commits when the page sends none */
export const FALLBACK_MESSAGE = "Update"

/** The sheet's rows, at most 8 */
const SHOWN = 8

/** The sheet's question for `ask`, from what `status` says, or Refused
 * when it would do nothing or jj-spr would refuse */
export function sprQuestion(ask: SprAsk, status: SprStatus): Question {
  const { entries } = status
  const upto =
    ask.tip === null ? entries.length - 1 : entries.findIndex((e) => e.tip === ask.tip)
  if (upto < 0) throw new Refused(404, "not a PR in this stack")
  // Newest first, as the page has them
  const scope = entries
    .slice(0, upto + 1)
    .filter((e) => !e.merged)
    .reverse()
  const title = (e: SprEntry) => e.title ?? e.tip
  const question = (verb: string, shown: SprEntry[], notes: string[], text = title) => {
    const rows = shown.map((e) => ({ id: e.pr ? `#${e.pr}` : "new", text: text(e) }))
    return {
      heading: `${verb} ${shown.length === 1 ? title(shown[0]) : `${shown.length} PRs`}?`,
      notes,
      rows: rows.slice(0, SHOWN),
      more: rows.length - Math.min(rows.length, SHOWN),
      button: verb,
    }
  }
  if (ask.command === "sync") {
    const merged = entries.filter((e) => !e.merged && e.state === "merged")
    return {
      ...question("Sync", merged, [
        "This abandons the merged changes, rebases the rest onto trunk, and marks those PRs merged in the stack file.",
      ]),
      heading: "Sync the stack?",
    }
  }
  if (ask.command === "land") {
    const fresh = scope.find((e) => !e.pr)
    if (fresh) throw new Refused(409, `${title(fresh)} isn't on GitHub yet`)
    const how =
      scope.length === 1
        ? "It's squash-merged on GitHub."
        : "Each is squash-merged on GitHub, bottom first."
    return question("Land", scope, [how])
  }
  const problems = status.problems.filter(
    (p) => p.tip === null || scope.some((e) => e.tip === p.tip),
  )
  if (problems.length)
    throw new Refused(
      409,
      `jj spr would refuse:\n${problems.map((p) => `- ${p.message}`).join("\n")}`,
    )
  const todo = scope.filter((e) => e.actions?.some(isTodo))
  if (!todo.length) throw new Refused(409, "Nothing to push: it's all up to date")
  const updates = todo.some((e) => e.pr && e.actions!.includes("push the changes"))
  const notes = updates
    ? ["Message for the commits that update open PRs:", ask.message || FALLBACK_MESSAGE]
    : []
  return question(
    "Push",
    todo,
    notes,
    (e) => `${title(e)}: ${e.actions!.filter(isTodo).join(", ")}`,
  )
}

/** jj spr's arguments for `ask`, on the stack file at `file` */
function sprArgs(ask: SprAsk, file: string): string[] {
  if (ask.command === "sync") return ["sync", file]
  const upto = ask.tip === null ? [] : ["--upto", ask.tip]
  if (ask.command === "land") return ["land", file, ...upto]
  return ["submit", file, ...upto, "-m", ask.message || FALLBACK_MESSAGE]
}

/** Repos with a run waiting on its sheet or running, by repo dir */
const busy = new Set<string>()

/** `{ done, output }` from jj spr on the stack file next to `pagePath`,
 * served at `page`, as the page's `body` asks, once the person confirms it
 * in `confirm`; jj-spr's complaint, with a 500, if it fails */
export async function runSpr(
  pagePath: string,
  page: URL,
  body: unknown,
  confirm: Confirm,
  spr: SprRun,
): Promise<Response> {
  const ask = parseAsk(body)
  if (!ask) return new Response("bad request", { status: 400 })
  const dir = dirname(pagePath)
  // At the root, where a terminal's would run
  const root = rootFinder()(dir)
  if (!root) return new Response(`${dir} isn't in a jj workspace`, { status: 500 })
  const repo = repoDir(root)
  if (busy.has(repo))
    return new Response(
      "jj spr is already running or waiting for confirmation in this repo",
      {
        status: 409,
      },
    )
  busy.add(repo)
  try {
    const question = sprQuestion(ask, await readStatus(pagePath, spr, true))
    const yes = await confirm(page, question)
    if (yes === null)
      throw new Refused(
        409,
        "Running jj spr needs this page in ah's window: open it with ah tool stack",
      )
    if (!yes) return Response.json({ done: false, output: "cancelled" })
    const out = await spr(root, ...sprArgs(ask, join(dir, STACK_FILE)))
    forgetGithub(pagePath)
    const output = [out.stdout, out.stderr].join("\n").trim()
    if (!out.success) return new Response(output || "jj spr failed", { status: 500 })
    return Response.json({ done: true, output })
  } catch (e) {
    const status = e instanceof Refused ? e.status : 500
    return new Response((e as Error).message, { status })
  } finally {
    busy.delete(repo)
  }
}
