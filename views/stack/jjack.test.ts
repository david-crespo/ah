import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  JjackError,
  type LandResult,
  type PullRequestResult,
  type Status,
  type StatusEntry,
  type SubmitResult,
  type SyncResult,
} from "jjack"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Question } from "../../platform/ask.ts"
import { STACK_FILE } from "./data.ts"
import { type Jjack, readStatus } from "./jjack.ts"
import { stackApp } from "./routes.ts"

let root: string
let notes: string
let file: string
let page: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-jjack-")))
  execFileSync("jj", ["git", "init"], { cwd: root, stdio: "pipe" })
  notes = join(root, "notes")
  mkdirSync(notes)
  const prs = [{ tip: "one", pr: 5 }, { tip: "two" }, { tip: "three", pr: 7 }]
  file = join(notes, STACK_FILE)
  writeFileSync(file, JSON.stringify({ prs }))
  page = join(notes, "index.html")
})

afterAll(() => rmSync(root, { recursive: true }))

/** Status as jjack would have it for the file, with what ah's server reads
 * of it: one and three are open on GitHub and two is new */
const entry = (tip: string, pr: number | null) =>
  ({
    tip,
    pr,
    merged: false,
    title: tip[0].toUpperCase() + tip.slice(1),
    ...(pr ? { state: "open" } : {}),
  }) as StatusEntry
const STATUS: Status = {
  file: "stack.json",
  trunk: "main@origin",
  entries: [entry("one", 5), entry("two", null), entry("three", 7)],
  problems: [],
}

/** A pull request in a submit's result, with what ah's server reads of it */
const pullRequest = (
  label: string,
  number: number | null,
  action: PullRequestResult["action"],
  text: PullRequestResult["text"] = null,
  updates: PullRequestResult["updates"] = action === "update" ? ["push"] : [],
) =>
  ({
    label,
    number,
    action,
    text,
    updates,
    title: label[0].toUpperCase() + label.slice(1),
  }) as PullRequestResult

/** A submit's dry run of the same stack, bottom first: one has an edit to
 * push, two is new, and three is up to date */
const plan = (...pullRequests: PullRequestResult[]): SubmitResult => ({
  dryRun: true,
  pullRequests,
  stacks: [],
})
const PLAN = plan(
  pullRequest("one", 5, "update", "title and body"),
  pullRequest("two", null, "create"),
  pullRequest("three", 7, "none"),
)

type Call = { command: string; root: string; file: string; options?: object }

/** A stack app whose window's sheet answers `answer` (null: there's no
 * window) and records what it asked. Its jjack answers `status` to status
 * and `plan` to a submit's dry run, throwing it if it's an error. A real
 * submit, land, or sync writes a line to its output, then throws `fail` if
 * there is one. ah reads none of their results. `runs` has each of those
 * calls. */
function app(
  answer: (q: Question) => Promise<boolean | null> | boolean | null,
  {
    status = STATUS,
    plan = PLAN,
    fail,
  }: { status?: Status; plan?: SubmitResult | JjackError; fail?: Error } = {},
) {
  const asked: Question[] = []
  const planned: Call[] = []
  const runs: Call[] = []
  const jjack: Jjack = {
    status: async () => status,
    async submit(root, file, options, out) {
      if (options.dryRun) {
        planned.push({ command: "submit", root, file, options })
        if (plan instanceof JjackError) throw plan
        return plan
      }
      runs.push({ command: "submit", root, file, options })
      out.line("🔁", "Pushing one")
      if (fail) throw fail
      return {} as SubmitResult
    },
    async land(root, file, options, out) {
      runs.push({ command: "land", root, file, options })
      out.line("🛬", "Landed #5")
      return {} as LandResult
    },
    async sync(root, file, out) {
      runs.push({ command: "sync", root, file })
      out.line("🧹", "Synced")
      return {} as SyncResult
    },
  }
  const confirm = async (_page: URL, q: Question) => {
    asked.push(q)
    return await answer(q)
  }
  const routes = stackApp(async () => {}, confirm, jjack)
  const run = async (command: string, tip: string | null, message = "") => {
    const req = new Request("http://127.0.0.1:7521/view/page/stack-1/_ah/jjack", {
      method: "POST",
      body: JSON.stringify({ command, tip, message }),
    })
    const res = (await routes.routes("_ah/jjack", req, page, null))!
    return { status: res.status, text: await res.text() }
  }
  const push = (tip: string | null, message = "") => run("submit", tip, message)
  return { run, push, asked, planned, runs }
}

test("Push shows jjack's dry run, then submits up to the PR", async () => {
  const { push, asked, planned, runs } = app(() => true)
  const res = await push("three", "Address review")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text)).toEqual({ done: true, output: "🔁  Pushing one" })
  expect(planned[0].options).toEqual({ upto: "three", dryRun: true })
  // Newest first, leaving out three, which is up to date
  expect(asked[0]).toEqual({
    heading: "Push 2 PRs?",
    notes: ["Message for the commits that update open PRs:", "Address review"],
    rows: [
      { id: "new", text: "Two: open a pull request" },
      { id: "#5", text: "One: push the changes, update the title and body" },
    ],
    more: 0,
    button: "Push",
  })
  const options = { upto: "three", message: "Address review" }
  expect(runs).toEqual([{ command: "submit", root, file, options }])
})

test("Push all has no upto, and an empty message sends none", async () => {
  const { push, asked, runs } = app(() => true)
  expect((await push(null)).status).toBe(200)
  // jjack picks the message, so the sheet has none to show
  expect(asked[0].notes).toEqual([])
  expect(runs[0].options).toEqual({ upto: undefined, message: undefined })
})

test("a row says what its push does, with a message only for an update", async () => {
  const fresh = app(() => false, { plan: plan(pullRequest("two", null, "create")) })
  await fresh.push("two", "Address review")
  expect(fresh.asked[0]).toMatchObject({
    heading: "Push Two?",
    notes: [],
    rows: [{ id: "new", text: "Two: open a pull request" }],
  })
  const one = pullRequest("one", 5, "update", null, ["merge", "retarget"])
  const moved = app(() => false, { plan: plan(one) })
  await moved.push("one")
  expect(moved.asked[0].rows).toEqual([
    { id: "#5", text: "One: merge in what's below it, retarget it" },
  ])
})

test("cancelling runs nothing but the dry run", async () => {
  const { push, planned, runs } = app(() => false)
  const res = await push("one")
  expect(JSON.parse(res.text)).toMatchObject({ done: false })
  expect(planned).toHaveLength(1)
  expect(runs).toEqual([])
})

test("a page with no window of ah's to ask in can't push", async () => {
  const { push, runs } = app(() => null)
  const res = await push("one")
  expect(res.status).toBe(409)
  expect(res.text).toContain("ah's window")
  expect(runs).toEqual([])
})

test("a dry run that refuses, or has nothing to do, refuses the push before the sheet", async () => {
  const message =
    "stack.json has 1 problem:\n- The tip 'two' is not a local bookmark or a change ID."
  const refused = app(() => true, { plan: new JjackError("problems", message) })
  expect(await refused.push("three")).toEqual({ status: 409, text: message })
  const upToDate = app(() => true, { plan: plan(pullRequest("one", 5, "none")) })
  expect(await upToDate.push("one")).toEqual({
    status: 409,
    text: "Nothing to push: it's all up to date",
  })
  for (const { asked, runs } of [refused, upToDate]) expect([asked, runs]).toEqual([[], []])
})

test("a second push while one's sheet is up is refused", async () => {
  const answer = Promise.withResolvers<boolean>()
  const { push, asked } = app(() => answer.promise)
  const first = push("one")
  await expect.poll(() => asked.length).toBe(1)
  expect((await push("one")).status).toBe(409)
  answer.resolve(false)
  expect((await first).status).toBe(200)
})

test("Land lands the PRs up to one, once they're all on GitHub", async () => {
  const { run, asked, runs } = app(() => true)
  expect(await run("land", "three")).toEqual({
    status: 409,
    text: "Two isn't on GitHub yet",
  })
  expect((await run("land", "other")).status).toBe(404)
  const res = await run("land", "one")
  expect(JSON.parse(res.text)).toEqual({ done: true, output: "🛬  Landed #5" })
  expect(asked).toEqual([
    {
      heading: "Land One?",
      notes: ["It's squash-merged on GitHub, then the stack is synced."],
      rows: [{ id: "#5", text: "One" }],
      more: 0,
      button: "Land",
    },
  ])
  expect(runs).toEqual([{ command: "land", root, file, options: { upto: "one" } }])
})

test("Sync lists the PRs merged on GitHub, and syncs", async () => {
  const merged = { ...STATUS.entries[0], state: "merged" as const }
  const status = { ...STATUS, entries: [merged, ...STATUS.entries.slice(1)] }
  const { run, asked, runs } = app(() => true, { status })
  const res = await run("sync", null)
  expect(JSON.parse(res.text)).toEqual({ done: true, output: "🧹  Synced" })
  expect(asked[0]).toMatchObject({
    heading: "Sync the stack?",
    rows: [{ id: "#5", text: "One" }],
    button: "Sync",
  })
  expect(runs).toEqual([{ command: "sync", root, file }])
})

test("a run that fails answers 500 with its output and why", async () => {
  const fail = new JjackError("remote_changes", "#5 changed on GitHub", {
    fix: ["jjack sync stack.json", "jjack submit stack.json"],
  }).context("Nothing was pushed for #5")
  const { push } = app(() => true, { fail })
  expect(await push("one")).toEqual({
    status: 500,
    text: [
      "🔁  Pushing one",
      "  🛑  #5 changed on GitHub",
      "  🛑  Nothing was pushed for #5",
    ].join("\n"),
  })
  // Anything else is one line
  const other = app(() => true, { fail: new Error("boom") })
  expect(await other.push("one")).toEqual({
    status: 500,
    text: "🔁  Pushing one\n  🛑  boom",
  })
})

test("readStatus asks jjack, keeps what it says, and doesn't keep a failure", async () => {
  const calls: string[] = []
  let answer: () => Promise<Status> = async () => STATUS
  const jjack = {
    status: async (_root: string, file: string) => {
      calls.push(file)
      return answer()
    },
  } as Jjack
  // A page of its own, so nothing else has cached its status
  const other = join(root, "other")
  mkdirSync(other)
  writeFileSync(join(other, STACK_FILE), JSON.stringify({ prs: [] }))
  const page = join(other, "index.html")
  expect(await readStatus(page, jjack)).toEqual(STATUS)
  expect(calls).toEqual([join(other, STACK_FILE)])
  // Kept until something changes, or asked for fresh
  await readStatus(page, jjack)
  expect(calls).toHaveLength(1)
  writeFileSync(join(other, STACK_FILE), JSON.stringify({ prs: [{ tip: "a" }] }))
  answer = async () => {
    throw new JjackError("config", "jjack.branchPrefix is not set")
  }
  await expect(readStatus(page, jjack)).rejects.toThrow("jjack.branchPrefix is not set")
  answer = async () => STATUS
  await readStatus(page, jjack)
  await readStatus(page, jjack, true)
  expect(calls).toHaveLength(4)
})
