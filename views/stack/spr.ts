// jj-spr, which owns the stack file and pushes its PRs (`jj spr`, run at the
// repo's root). Its status, for the page: what `submit` would do for each
// entry, and the problems it would refuse on. And the page's Push buttons,
// served at the page's _ah/spr: a button only asks, and the server shows
// what `submit` would do in a sheet on the page's window (platform/ask.ts),
// then runs it only once the person clicks Push there. A page with no window
// of ah's, like a browser tab, can't push. One run at a time per repo,
// counting the time its sheet is up.

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

/** What a page asks jj-spr to do: push the PRs up to the one with `tip`, or
 * all of them with null, with `message` for the commits that update
 * existing PRs */
export interface SprAsk {
  tip: string | null
  message: string
}

const parseAsk = (body: unknown): SprAsk | null =>
  isRecord(body) &&
  (body.tip === null || typeof body.tip === "string") &&
  typeof body.message === "string"
    ? { tip: body.tip, message: body.message }
    : null

/** The message for update commits when the page sends none */
export const FALLBACK_MESSAGE = "Update"

/** The sheet's rows, at most 8 */
const SHOWN = 8

/** The sheet's question for `ask`, from what `status` says submit would do,
 * or Refused when it would do nothing or refuse */
export function sprQuestion(ask: SprAsk, status: SprStatus): Question {
  const { entries } = status
  const upto =
    ask.tip === null ? entries.length - 1 : entries.findIndex((e) => e.tip === ask.tip)
  if (upto < 0) throw new Refused(404, "not a PR in this stack")
  const scope = entries.slice(0, upto + 1).filter((e) => !e.merged)
  const problems = status.problems.filter(
    (p) => p.tip === null || scope.some((e) => e.tip === p.tip),
  )
  if (problems.length)
    throw new Refused(
      409,
      `jj spr would refuse:\n${problems.map((p) => `- ${p.message}`).join("\n")}`,
    )
  const todo = scope.filter((e) => e.actions?.some(isTodo)).reverse()
  if (!todo.length) throw new Refused(409, "Nothing to push: it's all up to date")
  const rows = todo.map((e) => ({
    id: e.pr ? `#${e.pr}` : "new",
    text: `${e.title ?? e.tip}: ${e.actions!.filter(isTodo).join(", ")}`,
  }))
  const updates = todo.some((e) => e.pr && e.actions!.includes("push the changes"))
  return {
    heading:
      todo.length === 1
        ? `Push ${todo[0].title ?? todo[0].tip}?`
        : `Push ${todo.length} PRs?`,
    notes: updates
      ? ["The commits that update open PRs say:", ask.message || FALLBACK_MESSAGE]
      : [],
    rows: rows.slice(0, SHOWN),
    more: rows.length - Math.min(rows.length, SHOWN),
    button: "Push",
  }
}

/** Repos with a run waiting on its sheet or running, by repo dir */
const busy = new Set<string>()

/** `{ done, output }` from `jj spr submit` on the stack file next to
 * `pagePath`, served at `page`, as the page's `body` asks, once the person
 * confirms it in `confirm`; jj-spr's complaint, with a 500, if it fails */
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
    return new Response("jj spr is already waiting or running in this repo", {
      status: 409,
    })
  busy.add(repo)
  try {
    const question = sprQuestion(ask, await readStatus(pagePath, spr, true))
    const yes = await confirm(page, question)
    if (yes === null)
      throw new Refused(
        409,
        "Pushing needs this page in ah's window: open it with ah tool stack",
      )
    if (!yes) return Response.json({ done: false, output: "cancelled" })
    const upto = ask.tip === null ? [] : ["--upto", ask.tip]
    const message = ask.message || FALLBACK_MESSAGE
    const out = await spr(root, "submit", join(dir, STACK_FILE), ...upto, "-m", message)
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
