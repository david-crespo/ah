import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Question } from "../../platform/ask.ts"
import { type JjRun, jjRun } from "../../platform/jj.ts"
import type { Output } from "../../platform/proc.ts"
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
  // Where PRs open, which no test pushes to: origin isn't on GitHub
  jj("git", "remote", "add", "upstream", "https://github.com/o/r")
  // main: trunk. same: pushed as it is. ahead: pushed, then a commit on top.
  // rewritten: pushed, then described again. Never pushed: fresh, 10
  // commits on same; topic, one on same, with a body; side, one on main.
  commit("base.txt", "Base")
  jj("bookmark", "create", "main", "-r", "@-")
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
  jj("new", "same")
  commit("t.txt", "Topic")
  jj("bookmark", "create", "topic", "-r", "@-")
  jj("new", "main")
  commit("s.txt", "Side")
  jj("bookmark", "create", "side", "-r", "@-")
  const notes = join(dir, "notes")
  mkdirSync(notes)
  const pr = (n: number, bookmark: string) => ({ n, title: `PR ${n}`, bookmark })
  const bookmarks = ["same", "ahead", "rewritten", "fresh", "topic", "side"]
  const prs = bookmarks.map((b, i) => pr(i + 1, b))
  writeFileSync(join(notes, STACK_FILE), JSON.stringify({ title: "Stack", prs }))
  writeFileSync(join(notes, "topic.md"), "# Topic title\n\nWhat it does.\n")
  page = join(notes, "index.html")
})

afterAll(() => rmSync(root, { recursive: true }))

/** A stack app whose window's sheet answers `answer` (null: there's no
 * window) and records what it asked and of which page, and whose jj records
 * each command */
function app(
  answer: (q: Question) => Promise<boolean | null> | boolean | null,
  github: { open?: string[]; failCreate?: boolean } = {},
) {
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
  // gh: the PRs open on GitHub, by head, and a new PR at /pull/7, with each
  // `gh pr create`'s arguments and its body file's text
  const created: { args: string[]; body: string }[] = []
  const gh = async (...args: string[]): Promise<Output> => {
    const ok = (stdout: string) => ({ success: true, code: 0, stdout, stderr: "" })
    if (args[0] === "pr" && args[1] === "create") {
      const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8")
      created.push({ args, body })
      return github.failCreate
        ? { success: false, code: 1, stdout: "", stderr: "GraphQL: boom" }
        : ok("https://github.com/o/r/pull/7\n")
    }
    // api graphql, with each head as -f hN=bookmark
    const heads = args.flatMap((a) => a.match(/^(h\d+)=(.*)$/)?.slice(1) ?? [])
    const repository: Record<string, { nodes: object[] }> = {}
    for (let i = 0; i < heads.length; i += 2) {
      const open = github.open?.includes(heads[i + 1])
      const pr = { number: 1, url: "u", state: "OPEN", isDraft: false, title: "t" }
      const rest = { baseRefName: "main", headRefOid: "x", reviewDecision: null }
      const node = { ...pr, ...rest, isCrossRepository: false, commits: { nodes: [] } }
      repository[heads[i]] = { nodes: open ? [node] : [] }
    }
    return ok(JSON.stringify({ data: { repository } }))
  }
  const routes = stackApp(async () => {}, confirm, run, gh)
  const push = async (bookmark: string) => {
    const req = new Request("http://127.0.0.1:7521/view/page/stack-1/_ah/push", {
      method: "POST",
      body: JSON.stringify({ bookmark }),
    })
    const res = (await routes.routes("_ah/push", req, page, null))!
    return { status: res.status, text: await res.text() }
  }
  const pushed = () => ran.some((args) => args[0] === "git" && args[1] === "push")
  const json = async (bookmark: string) => {
    const res = await push(bookmark)
    expect(res.status).toBe(200)
    return JSON.parse(res.text) as { pushed: boolean; pr?: string; prError?: string }
  }
  return { push, json, asked, pages, pushed, created }
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
  // The PR below it isn't open, so its PR goes into trunk; it has no body,
  // so its title is stack.json's
  expect(q.notes).toEqual([
    "New branch on origin.",
    "Then a PR opens into main, titled:",
    "PR 4",
    "Its description is empty.",
  ])
  expect(q.button).toBe("Push and create PR")
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

test("a new branch opens its PR into the open PR below it, from its body", async () => {
  const { json, asked, created } = app(() => true, { open: ["same"] })
  expect(await json("topic")).toMatchObject({
    pushed: true,
    pr: "https://github.com/o/r/pull/7",
  })
  expect(asked[0].notes).toEqual([
    "New branch on origin.",
    "Then a PR opens into same, titled:",
    "Topic title",
  ])
  expect(remoteRef("topic")).toBe(localRef("topic"))
  const [{ args, body }] = created
  expect(args.slice(0, -1)).toEqual([
    ...["pr", "create", "--repo", "o/r", "--head", "topic", "--base", "same"],
    ...["--title", "Topic title", "--body-file"],
  ])
  expect(body).toBe("What it does.")
})

test("a PR beside another on trunk goes into trunk, and one that fails leaves the push", async () => {
  // same is open, but side is built on main, not on same
  const { json, asked, created } = app(() => true, { open: ["same"], failCreate: true })
  expect(await json("side")).toMatchObject({ pushed: true, prError: "GraphQL: boom" })
  expect(asked[0].notes[1]).toBe("Then a PR opens into main, titled:")
  expect(created[0].args).toContain("main")
  expect(remoteRef("side")).toBe(localRef("side"))
})

test("Push in the sheet pushes the bookmark to the remote", async () => {
  const { push, created } = app(() => true)
  expect(remoteRef("ahead")).not.toBe(localRef("ahead"))
  const res = await push("ahead")
  expect(res.text).toContain("bookmark: ahead [move forward from")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text)).toMatchObject({ pushed: true })
  expect(remoteRef("ahead")).toBe(localRef("ahead"))
  // It was on the remote already, so no PR, though it has none
  expect(created).toEqual([])

  expect(remoteRef("fresh")).toBe("")
  expect((await push("fresh")).status).toBe(200)
  expect(remoteRef("fresh")).toBe(localRef("fresh"))
})
