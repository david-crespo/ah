import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Question } from "../../platform/ask.ts"
import type { Output } from "../../platform/proc.ts"
import { STACK_FILE } from "./data.ts"
import { stackApp } from "./routes.ts"
import { readStatus, type SprStatus } from "./spr.ts"

let root: string
let notes: string
let page: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-spr-")))
  execFileSync("jj", ["git", "init"], { cwd: root, stdio: "pipe" })
  notes = join(root, "notes")
  mkdirSync(notes)
  const prs = [{ tip: "one", pr: 5 }, { tip: "two" }, { tip: "three", pr: 7 }]
  writeFileSync(join(notes, STACK_FILE), JSON.stringify({ prs }))
  page = join(notes, "index.html")
})

afterAll(() => rmSync(root, { recursive: true }))

/** Status as jj-spr would have it for the file: one is on GitHub with an
 * edit to push, two is new, and three is up to date */
const STATUS: SprStatus = {
  entries: [
    {
      tip: "one",
      pr: 5,
      merged: false,
      title: "One",
      state: "open",
      actions: ["push the changes", "update the title and body"],
    },
    { tip: "two", pr: null, merged: false, title: "Two", actions: ["open a Pull Request"] },
    {
      tip: "three",
      pr: 7,
      merged: false,
      title: "Three",
      state: "open",
      actions: ["nothing: it is up to date"],
    },
  ],
  problems: [],
}

const ok = (stdout: string): Output => ({ success: true, code: 0, stdout, stderr: "" })

/** A stack app whose window's sheet answers `answer` (null: there's no
 * window) and records what it asked, and whose jj spr answers `status` to
 * status and `submit` to submit, recording each run's directory and
 * arguments */
function app(
  answer: (q: Question) => Promise<boolean | null> | boolean | null,
  {
    status = STATUS,
    submit = ok("Pushed.\n"),
  }: { status?: SprStatus; submit?: Output } = {},
) {
  const asked: Question[] = []
  const ran: { cwd: string; args: string[] }[] = []
  const spr = async (cwd: string, ...args: string[]) => {
    ran.push({ cwd, args })
    return args[0] === "stack-file" ? ok(JSON.stringify(status)) : submit
  }
  const confirm = async (_page: URL, q: Question) => {
    asked.push(q)
    return await answer(q)
  }
  const routes = stackApp(async () => {}, confirm, spr)
  const run = async (command: string, tip: string | null, message = "") => {
    const req = new Request("http://127.0.0.1:7521/view/page/stack-1/_ah/spr", {
      method: "POST",
      body: JSON.stringify({ command, tip, message }),
    })
    const res = (await routes.routes("_ah/spr", req, page, null))!
    return { status: res.status, text: await res.text() }
  }
  const push = (tip: string | null, message = "") => run("submit", tip, message)
  /** What jj spr ran other than status */
  const submits = () => ran.filter((r) => r.args[0] !== "stack-file")
  return { run, push, asked, ran, submits }
}

test("Push shows what jj-spr would do, then runs submit up to the PR", async () => {
  const { push, asked, submits } = app(() => true)
  const res = await push("three", "Address review")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text)).toEqual({ done: true, output: "Pushed." })
  // Newest first, leaving out three, which is up to date
  expect(asked[0]).toEqual({
    heading: "Push 2 PRs?",
    notes: ["Message for the commits that update open PRs:", "Address review"],
    rows: [
      { id: "new", text: "Two: open a Pull Request" },
      { id: "#5", text: "One: push the changes, update the title and body" },
    ],
    more: 0,
    button: "Push",
  })
  const file = join(notes, STACK_FILE)
  expect(submits()).toEqual([
    { cwd: root, args: ["submit", file, "--upto", "three", "-m", "Address review"] },
  ])
})

test("Push all has no --upto, and an empty message is Update", async () => {
  const { push, submits } = app(() => true)
  expect((await push(null)).status).toBe(200)
  expect(submits()[0].args.slice(2)).toEqual(["-m", "Update"])
})

test("a PR's push sends the ones below it, and a new PR's has no update commits", async () => {
  const { push, asked } = app(() => false)
  await push("two")
  expect(asked[0]).toMatchObject({ heading: "Push 2 PRs?" })
  expect(asked[0].rows.map((r) => r.id)).toEqual(["new", "#5"])
  const status = { ...STATUS, entries: STATUS.entries.slice(1) }
  const fresh = app(() => false, { status })
  await fresh.push("two")
  expect(fresh.asked[0]).toMatchObject({ heading: "Push Two?", notes: [] })
})

test("cancelling runs nothing", async () => {
  const { push, submits } = app(() => false)
  const res = await push("one")
  expect(JSON.parse(res.text)).toMatchObject({ done: false })
  expect(submits()).toEqual([])
})

test("a page with no window of ah's to ask in can't push", async () => {
  const { push, submits } = app(() => null)
  const res = await push("one")
  expect(res.status).toBe(409)
  expect(res.text).toContain("ah's window")
  expect(submits()).toEqual([])
})

test("jj-spr's problems with the PRs a push sends refuse it before the sheet", async () => {
  const problems = [
    { tip: "two", message: "The tip 'two' is not a local bookmark or a change ID." },
  ]
  const { push, asked } = app(() => true, { status: { ...STATUS, problems } })
  const res = await push("three")
  expect(res).toEqual({
    status: 409,
    text: "jj spr would refuse:\n- The tip 'two' is not a local bookmark or a change ID.",
  })
  expect(asked).toEqual([])
  // One above the PR doesn't
  expect((await push("one")).status).toBe(200)
})

test("a push with nothing to do, or of a tip not in the stack, is refused", async () => {
  const { push, asked } = app(() => true)
  const status = {
    ...STATUS,
    entries: [{ ...STATUS.entries[2], tip: "one" }, ...STATUS.entries.slice(1)],
  }
  const upToDate = app(() => true, { status })
  expect(await upToDate.push("one")).toEqual({
    status: 409,
    text: "Nothing to push: it's all up to date",
  })
  expect((await push("other")).status).toBe(404)
  expect(asked).toEqual([])
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
  const { run, asked, submits } = app(() => true)
  expect(await run("land", "three")).toEqual({
    status: 409,
    text: "Two isn't on GitHub yet",
  })
  expect((await run("land", "one")).status).toBe(200)
  expect(asked).toEqual([
    {
      heading: "Land One?",
      notes: ["It's squash-merged on GitHub."],
      rows: [{ id: "#5", text: "One" }],
      more: 0,
      button: "Land",
    },
  ])
  expect(submits().map((r) => r.args)).toEqual([
    ["land", join(notes, STACK_FILE), "--upto", "one"],
  ])
})

test("Sync lists the PRs merged on GitHub, and runs sync", async () => {
  const merged = { ...STATUS.entries[0], state: "merged" as const, actions: [] }
  const status = { ...STATUS, entries: [merged, ...STATUS.entries.slice(1)] }
  const { run, asked, submits } = app(() => true, { status })
  expect((await run("sync", null)).status).toBe(200)
  expect(asked[0]).toMatchObject({
    heading: "Sync the stack?",
    rows: [{ id: "#5", text: "One" }],
    button: "Sync",
  })
  expect(submits().map((r) => r.args)).toEqual([["sync", join(notes, STACK_FILE)]])
})

test("a submit that fails answers 500 with jj-spr's output", async () => {
  const submit = { success: false, code: 1, stdout: "Pushing one", stderr: "🛑  boom" }
  const { push } = app(() => true, { submit })
  expect(await push("one")).toEqual({ status: 500, text: "Pushing one\n🛑  boom" })
})

test("readStatus reads status with problems, says why it failed, and keeps it", async () => {
  const calls: string[][] = []
  let answer: Output = { ...ok(JSON.stringify(STATUS)), success: false, code: 1 }
  const spr = async (_cwd: string, ...args: string[]) => {
    calls.push(args)
    return answer
  }
  // A page of its own, so nothing else has cached its status
  const other = join(root, "other")
  mkdirSync(other)
  writeFileSync(join(other, STACK_FILE), JSON.stringify({ prs: [] }))
  const page = join(other, "index.html")
  // It exits 1 with problems, and still prints them
  expect(await readStatus(page, spr)).toEqual(STATUS)
  expect(calls).toEqual([["stack-file", "status", join(other, STACK_FILE), "--json"]])
  // Kept until something changes, or asked for fresh
  await readStatus(page, spr)
  expect(calls).toHaveLength(1)
  writeFileSync(join(other, STACK_FILE), JSON.stringify({ prs: [{ tip: "a" }] }))
  answer = {
    success: false,
    code: 1,
    stdout: "",
    stderr: "  🛑  spr.githubRepository is not configured\n",
  }
  await expect(readStatus(page, spr)).rejects.toThrow(
    /^🛑 {2}spr.githubRepository is not configured$/,
  )
  answer = ok(JSON.stringify(STATUS))
  await readStatus(page, spr)
  await readStatus(page, spr, true)
  expect(calls).toHaveLength(4)
})
