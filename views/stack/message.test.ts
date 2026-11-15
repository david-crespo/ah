import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Output } from "../../platform/proc.ts"
import { STACK_FILE, type StackEntry } from "./data.ts"
import { stackApp } from "./routes.ts"

let root: string
let page: string
const jj = (...args: string[]) =>
  execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
    cwd: root,
    stdio: "pipe",
  }).toString()
const commitId = (rev: string) => jj("log", "--no-graph", "-r", rev, "-T", "commit_id")
const write = (prs: StackEntry[]) =>
  writeFileSync(join(root, "notes", STACK_FILE), JSON.stringify({ prs }))

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-message-")))
  jj("git", "init")
  // So that checking out a commit leaves the stack file alone
  writeFileSync(join(root, ".gitignore"), "notes/\n")
  jj("commit", "-m", "Ignore notes")
  for (const [name, bookmark] of [
    ["a", "one"],
    ["b", "two"],
  ]) {
    writeFileSync(join(root, `${name}.txt`), `${name}\n`)
    jj("commit", "-m", `Add ${name}`)
    jj("bookmark", "create", bookmark, "-r", "@-")
  }
  mkdirSync(join(root, "notes"))
  page = join(root, "notes", "index.html")
})

afterAll(() => rmSync(root, { recursive: true }))

/** A stack app whose ai answers `answer`, recording each call's arguments
 * and stdin */
function app(answer: Output) {
  const calls: { args: string[]; input: string }[] = []
  const ai = async (args: string[], input: string) => {
    calls.push({ args, input })
    return answer
  }
  const routes = stackApp(
    async () => {},
    async () => {},
    undefined,
    undefined,
    undefined,
    ai,
  )
  const draft = async (tip: string | null) => {
    const req = new Request("http://127.0.0.1:7521/view/page/stack-1/_ah/push-message", {
      method: "POST",
      body: JSON.stringify({ tip }),
    })
    const res = (await routes.routes("_ah/push-message", req, page, null))!
    expect(res.status).toBe(200)
    return ((await res.json()) as { message: string }).message
  }
  return { draft, calls }
}

const said = (stdout: string): Output => ({ success: true, code: 0, stdout, stderr: "" })

test("the draft comes from the interdiff since jj-spr's push, and is kept", async () => {
  const pushed = { one: commitId("one"), two: commitId("two") }
  write([
    { tip: "one", pr: 1, pushed: pushed.one },
    { tip: "two", pr: 2, pushed: pushed.two, title: "Two" },
  ])
  // two's line changes; one's doesn't
  jj("edit", "two")
  writeFileSync(join(root, "b.txt"), "B, louder\n")
  jj("new")
  const { draft, calls } = app(said('"Make b louder."\n'))
  // Nothing to draft from up to one, so no call
  expect(await draft("one")).toBe("Update")
  expect(calls).toEqual([])
  expect(await draft("two")).toBe("Make b louder")
  expect(calls).toHaveLength(1)
  expect(calls[0].args).toEqual(["-m", "neon", "-q", "--raw", "--ephemeral"])
  const { input } = calls[0]
  expect(input).toMatch(/^Write the message for a commit that updates a pull request/)
  expect(input).toContain("## Two\n\ndiff --git a/b.txt b/b.txt")
  expect(input).toContain("+B, louder")
  // The same PRs changed the same way, from Push all
  expect(await draft(null)).toBe("Make b louder")
  expect(calls).toHaveLength(1)
})

test("a failed or empty draft is Update, and isn't kept", async () => {
  const pushed = commitId("two")
  write([{ tip: "one" }, { tip: "two", pr: 2, pushed }])
  jj("edit", "two")
  writeFileSync(join(root, "b.txt"), "B, louder still\n")
  jj("new")
  const failed = app({ success: false, code: null, stdout: "", stderr: "" })
  expect(await failed.draft("two")).toBe("Update")
  const empty = app(said("\n"))
  expect(await empty.draft("two")).toBe("Update")
  expect([failed.calls.length, empty.calls.length]).toEqual([1, 1])
})

test("PRs only rebased since their push draft Rebase, with no call", async () => {
  // trunk is main on origin, at the first commit
  // In notes, which jj ignores here
  execFileSync("git", ["init", "--bare", "--quiet", join(root, "notes", "remote.git")])
  jj("git", "remote", "add", "origin", join(root, "notes", "remote.git"))
  jj("bookmark", "create", "main", "-r", "root()+")
  jj("git", "push", "--bookmark", "main")
  write([
    { tip: "one", pr: 1, pushed: commitId("one") },
    { tip: "two", pr: 2, pushed: commitId("two") },
  ])
  // Then main moves on, and the stack moves onto it
  jj("new", "main")
  writeFileSync(join(root, "m.txt"), "m\n")
  jj("commit", "-m", "On main")
  jj("bookmark", "move", "main", "--to", "@-")
  jj("git", "push", "--bookmark", "main")
  jj("rebase", "-b", "two", "-d", "main")
  const { draft, calls } = app(said("Never asked"))
  expect(await draft("two")).toBe("Rebase")
  expect(calls).toEqual([])
})
