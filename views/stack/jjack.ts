// jjack, which owns the stack file and pushes its PRs, imported as a library
// and run at the workspace's root. Its status, for the page: what `submit`
// would do for each entry, and the problems it would refuse on. And the
// page's Push, Land, and Sync buttons, served at the page's _ah/jjack: a
// button only asks. The server shows what jjack would do in a sheet on the
// page's window (platform/ask.ts), then runs it only once the person clicks
// there. A page with no window of ah's, like a browser tab, can't run one.
// One run at a time per repo, counting the time its sheet is up.

import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  captureOut,
  JjackError,
  land,
  openContext,
  printError,
  status,
  submit,
  sync,
  toJjackError,
  type LandOptions,
  type LandResult,
  type Out,
  type Status,
  type StatusEntry,
  type SubmitOptions,
  type SubmitResult,
  type SyncResult,
} from "jjack"
import { rootFinder } from "../../core/workspace.ts"
import type { Confirm, Question } from "../../platform/ask.ts"
import { isRecord } from "../../platform/guards.ts"
import { opHeadsDir, repoDir } from "../../platform/jj.ts"
import { run } from "../../platform/proc.ts"
import { parseStackFile, STACK_FILE } from "./data.ts"
import { forgetGithub } from "./github.ts"

/** jjack's commands on a stack file, run at a workspace's root, which tests
 * stand in for */
export interface Jjack {
  status(root: string, file: string): Promise<Status>
  submit(
    root: string,
    file: string,
    options: SubmitOptions,
    out: Out,
  ): Promise<SubmitResult>
  land(root: string, file: string, options: LandOptions, out: Out): Promise<LandResult>
  sync(root: string, file: string, out: Out): Promise<SyncResult>
}

/** jjack's library, with a context of its own for each call */
export const jjackLibrary: Jjack = {
  status: async (root, file) =>
    status(await openContext(root, { out: captureOut() }), file),
  submit: async (root, file, options, out) =>
    submit(await openContext(root, { out }), { file }, options),
  land: async (root, file, options, out) =>
    land(await openContext(root, { out }), { file }, options),
  sync: async (root, file, out) => sync(await openContext(root, { out }), { file }),
}

const TTL = 30_000
const statuses = new Map<string, { key: string; at: number; status: Promise<Status> }>()

/** jjack's status for the stack file next to `pagePath`. Kept while the
 * file, its bodies, and the repo's operations are as they were, for up to
 * TTL, since jjack asks GitHub too; `fresh` asks again regardless. */
export async function readStatus(
  pagePath: string,
  jjack: Jjack,
  fresh = false,
): Promise<Status> {
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
  const answer = jjack.status(root, file)
  statuses.set(pagePath, { key, at: Date.now(), status: answer })
  // A failure shouldn't stick
  answer.catch(() => statuses.delete(pagePath))
  return answer
}

/** A run that won't happen, with why, as an HTTP status */
class Refused extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Command = "submit" | "land" | "sync"

/** What a page asks jjack to do: submit or land the PRs up to the one with
 * `tip`, or all of them with null, or sync the stack. `message` is for the
 * commits a submit adds to open PRs. */
export interface Ask {
  command: Command
  tip: string | null
  message: string
}

const parseAsk = (body: unknown): Ask | null =>
  isRecord(body) &&
  (body.command === "submit" || body.command === "land" || body.command === "sync") &&
  (body.tip === null || typeof body.tip === "string") &&
  typeof body.message === "string"
    ? { command: body.command, tip: body.tip, message: body.message }
    : null

/** The sheet's rows, at most 8 */
const SHOWN = 8

/** A sheet that asks to `verb` the PRs of `rows`, newest first */
function sheet(
  verb: string,
  rows: { id: string; title: string; text: string }[],
  notes: string[],
): Question {
  return {
    heading: `${verb} ${rows.length === 1 ? rows[0].title : `${rows.length} PRs`}?`,
    notes,
    rows: rows.slice(0, SHOWN).map(({ id, text }) => ({ id, text })),
    more: rows.length - Math.min(rows.length, SHOWN),
    button: verb,
  }
}

/** What an update of an open PR does, as a row says it */
const UPDATES = {
  push: "push the changes",
  merge: "merge in what's below it",
  retarget: "retarget it",
}

/** The sheet's question for a push, from jjack's dry run of it, or Refused
 * when it would do nothing */
function pushQuestion(ask: Ask, plan: SubmitResult): Question {
  // Newest first, as the page has them
  const todo = plan.pullRequests.filter((p) => p.action !== "none" || p.text !== null)
  todo.reverse()
  if (!todo.length) throw new Refused(409, "Nothing to push: it's all up to date")
  const rows = todo.map((p) => {
    const what = [
      p.action === "create" ? "open a pull request" : "",
      ...p.updates.map((u) => UPDATES[u]),
      p.text ? `update the ${p.text}` : "",
    ].filter(Boolean)
    const id = p.number === null ? "new" : `#${p.number}`
    return { id, title: p.title, text: `${p.title}: ${what.join(", ")}` }
  })
  const updates = todo.some((p) => p.number !== null && p.action === "update")
  const notes =
    updates && ask.message
      ? ["Message for the commits that update open PRs:", ask.message]
      : []
  return sheet("Push", rows, notes)
}

/** The sheet's question for a land or a sync, from what `status` says, or
 * Refused when a PR to land isn't on GitHub */
function statusQuestion(ask: Ask, { entries }: Status): Question {
  const title = (e: StatusEntry) => e.title ?? e.tip
  const rows = (shown: StatusEntry[]) =>
    shown.map((e) => ({ id: e.pr ? `#${e.pr}` : "new", title: title(e), text: title(e) }))
  if (ask.command === "sync") {
    const merged = entries.filter((e) => !e.merged && e.state === "merged")
    return {
      ...sheet("Sync", rows(merged), [
        "This abandons the merged changes, rebases the rest onto trunk, and marks those PRs merged in the stack file.",
      ]),
      heading: "Sync the stack?",
    }
  }
  const upto =
    ask.tip === null ? entries.length - 1 : entries.findIndex((e) => e.tip === ask.tip)
  if (upto < 0) throw new Refused(404, "not a PR in this stack")
  // Newest first, as the page has them
  const scope = entries
    .slice(0, upto + 1)
    .filter((e) => !e.merged)
    .reverse()
  const fresh = scope.find((e) => !e.pr)
  if (fresh) throw new Refused(409, `${title(fresh)} isn't on GitHub yet`)
  const how =
    scope.length === 1
      ? "It's squash-merged on GitHub, then the stack is synced."
      : "Each is squash-merged on GitHub, bottom first, then the stack is synced."
  return sheet("Land", rows(scope), [how])
}

/** Repos with a run waiting on its sheet or running, by repo dir */
const busy = new Set<string>()

/** `{ done, output }` from jjack on the stack file next to `pagePath`,
 * served at `page`, as the page's `body` asks, once the person confirms it
 * in `confirm`. If it fails, its output up to then and why, with a 500. */
export async function runJjack(
  pagePath: string,
  page: URL,
  body: unknown,
  confirm: Confirm,
  jjack: Jjack,
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
      "jjack is already running or waiting for confirmation in this repo",
      { status: 409 },
    )
  busy.add(repo)
  try {
    const file = join(dir, STACK_FILE)
    const upto = ask.tip ?? undefined
    let question: Question
    if (ask.command === "submit") {
      // jjack's reads take no snapshot and its submit does, so take one
      // first: the sheet then shows what the submit pushes
      await run("jj", ["util", "snapshot"], { cwd: root })
      const plan = await jjack
        .submit(root, file, { upto, dryRun: true }, captureOut())
        .catch((e: unknown) => {
          throw e instanceof JjackError ? new Refused(409, e.message) : e
        })
      question = pushQuestion(ask, plan)
    } else {
      // Land has no dry run, and sync's fetches before the person confirms
      question = statusQuestion(ask, await readStatus(pagePath, jjack, true))
    }
    const yes = await confirm(page, question)
    if (yes === null)
      throw new Refused(
        409,
        "Running jjack needs this page in ah's window: open it with ah tool stack",
      )
    if (!yes) return Response.json({ done: false, output: "cancelled" })
    const out = captureOut()
    try {
      if (ask.command === "submit")
        await jjack.submit(root, file, { upto, message: ask.message || undefined }, out)
      else if (ask.command === "land") await jjack.land(root, file, { upto }, out)
      else await jjack.sync(root, file, out)
      return Response.json({ done: true, output: out.text.trim() })
    } catch (e) {
      // As jjack's command line prints it. The messages say how to fix it.
      printError(out, toJjackError(e))
      return new Response(out.text.trim(), { status: 500 })
    } finally {
      forgetGithub(pagePath)
    }
  } catch (e) {
    const code = e instanceof Refused ? e.status : 500
    return new Response((e as Error).message, { status: code })
  } finally {
    busy.delete(repo)
  }
}
