import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Question } from "../../platform/ask.ts"
import { type JjRun, jjRun } from "../../platform/jj.ts"
import { STACK_FILE } from "./data.ts"
import { stackApp } from "./routes.ts"

// The repo, and its remote beside it, outside the working copy, which
// checking out an older commit would empty
let root: string
let dir: string
let remote: string
let page: string
const jj = (...args: string[]) =>
  execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
    cwd: dir,
    stdio: "pipe",
  }).toString()
const commit = (file: string, message: string) => {
  writeFileSync(join(dir, file), `${file}\n`)
  jj("commit", "-m", message)
}
/** The commit `ref` is at in the remote, or "" without it */
const remoteRef = (ref: string) => {
  try {
    return execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${ref}`], {
      stdio: "pipe",
    })
      .toString()
      .trim()
  } catch {
    return ""
  }
}
const localRef = (bookmark: string) =>
  jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id")

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-push-")))
  dir = join(root, "repo")
  remote = join(root, "remote.git")
  mkdirSync(dir)
  jj("git", "init")
  execFileSync("git", ["init", "--bare", "--quiet", remote])
  jj("git", "remote", "add", "origin", remote)
  // same: pushed as it is. ahead: pushed, then a commit on top. rewritten:
  // pushed, then described again. fresh: never pushed, 10 commits.
  commit("a.txt", "Add a")
  jj("bookmark", "create", "same", "-r", "@-")
  commit("b.txt", "Add b")
  jj("bookmark", "create", "ahead", "-r", "@-")
  commit("c.txt", "Add c")
  jj("bookmark", "create", "rewritten", "-r", "@-")
  jj("git", "push", "--bookmark", "glob:*")
  jj("new", "ahead")
  commit("d.txt", 'Say "hi" to `them`\n\nand "more" here')
  jj("bookmark", "move", "ahead", "--allow-backwards", "--to", "@-")
  jj("describe", "rewritten", "-m", "Add c, edited")
  jj("new", "same")
  for (let i = 1; i <= 10; i++) commit(`f${i}.txt`, `Fresh ${i}`)
  jj("bookmark", "create", "fresh", "-r", "@-")
  const notes = join(dir, "notes")
  mkdirSync(notes)
  const pr = (n: number, bookmark: string) => ({ n, title: `PR ${n}`, bookmark })
  const prs = ["same", "ahead", "rewritten", "fresh"].map((b, i) => pr(i + 1, b))
  writeFileSync(join(notes, STACK_FILE), JSON.stringify({ title: "Stack", prs }))
  page = join(notes, "index.html")
})

afterAll(() => rmSync(root, { recursive: true }))

/** A stack app whose window's sheet answers `answer` (null: there's no
 * window) and records what it asked and of which page, and whose jj records
 * each command */
function app(answer: (q: Question) => Promise<boolean | null> | boolean | null) {
  const asked: Question[] = []
  const pages: string[] = []
  const ran: string[][] = []
  const run: JjRun = (cwd, ...args) => {
    ran.push(args)
    return jjRun(cwd, ...args)
  }
  const confirm = async (page: URL, q: Question) => {
    pages.push(page.href)
    asked.push(q)
    return await answer(q)
  }
  const routes = stackApp(async () => {}, confirm, run)
  const push = async (bookmark: string) => {
    const req = new Request("http://127.0.0.1:7521/view/page/stack-1/_ah/push", {
      method: "POST",
      body: JSON.stringify({ bookmark }),
    })
    const res = (await routes.routes("_ah/push", req, page, null))!
    return { status: res.status, text: await res.text() }
  }
  const pushed = () => ran.some((args) => args[0] === "git" && args[1] === "push")
  return { push, asked, pages, pushed }
}

test("a bookmark that isn't one of the stack's PRs is a 404", async () => {
  const { push, asked } = app(() => true)
  expect((await push("other")).status).toBe(404)
  expect(asked).toEqual([])
})

test("a push that would rewrite what's pushed is refused", async () => {
  const { push, asked, pushed } = app(() => true)
  const res = await push("rewritten")
  expect(res.status).toBe(409)
  expect(res.text).toContain("Push a rewrite by hand")
  expect(asked).toEqual([])
  expect(pushed()).toBe(false)
})

test("a bookmark with nothing to push is refused", async () => {
  const { push, asked } = app(() => true)
  const res = await push("same")
  expect(res).toEqual({ status: 409, text: "same has nothing to push to origin" })
  expect(asked).toEqual([])
})

test("a new branch's sheet says so, and lists 8 commits and how many more", async () => {
  const { push, asked, pages } = app(() => false)
  await push("fresh")
  const [q] = asked
  expect(pages).toEqual(["http://127.0.0.1:7521/view/page/stack-1/"])
  expect(q.heading).toBe("Push fresh to origin?")
  expect(q.notes).toEqual(["New branch on origin."])
  expect(q.button).toBe("Push")
  // Newest first, and none of what origin has under other bookmarks
  expect(q.rows.map((r) => r.text)).toEqual(
    [10, 9, 8, 7, 6, 5, 4, 3].map((n) => `Fresh ${n}`),
  )
  expect(q.rows.every((r) => /^\w{8}$/.test(r.id))).toBe(true)
  expect(q.more).toBe(2)
})

test("cancelling leaves jj unrun, and a commit's row is its first line", async () => {
  const { push, asked, pushed } = app(() => false)
  const res = await push("ahead")
  expect(res).toEqual({ status: 200, text: '{"pushed":false,"output":"cancelled"}' })
  expect(pushed()).toBe(false)
  const [q] = asked
  expect(q.notes).toEqual([])
  expect(q.rows.map((r) => r.text)).toEqual(['Say "hi" to `them`'])
})

test("a page with no window of ah's to ask in can't push", async () => {
  const { push, pushed } = app(() => null)
  const res = await push("ahead")
  expect(res.status).toBe(409)
  expect(res.text).toContain("ah's window")
  expect(pushed()).toBe(false)
})

test("a second push while one's sheet is up is refused", async () => {
  const answer = Promise.withResolvers<boolean>()
  const { push, asked } = app(() => answer.promise)
  const first = push("ahead")
  await expect.poll(() => asked.length).toBe(1)
  expect((await push("fresh")).status).toBe(409)
  answer.resolve(false)
  expect((await first).status).toBe(200)
  expect(asked).toHaveLength(1)
})

test("Push in the sheet pushes the bookmark to the remote", async () => {
  const { push } = app(() => true)
  expect(remoteRef("ahead")).not.toBe(localRef("ahead"))
  const res = await push("ahead")
  expect(res.text).toContain("bookmark: ahead [move forward from")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text)).toMatchObject({ pushed: true })
  expect(remoteRef("ahead")).toBe(localRef("ahead"))

  expect(remoteRef("fresh")).toBe("")
  expect((await push("fresh")).status).toBe(200)
  expect(remoteRef("fresh")).toBe(localRef("fresh"))
})
