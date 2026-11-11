import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { type JjRun, jjRun } from "../../platform/jj.ts"
import { STACK_FILE } from "./data.ts"
import { fetchRepo } from "./fetch.ts"

// Two repos and the bare remote between them: `there` pushes, and the stack's
// repo, `here`, fetches
const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-fetch-")))
afterAll(() => rmSync(root, { recursive: true }))
const remote = join(root, "remote.git")
const repo = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir)
  const jj = (...args: string[]) =>
    execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
      cwd: dir,
      stdio: "pipe",
    }).toString()
  jj("git", "init")
  jj("git", "remote", "add", "origin", remote)
  return { dir, jj }
}
execFileSync("git", ["init", "--bare", "--quiet", remote])
const here = repo("here")
const there = repo("there")
mkdirSync(join(here.dir, "notes"))
writeFileSync(join(here.dir, "notes", STACK_FILE), JSON.stringify({ title: "S", prs: [] }))
const page = join(here.dir, "notes", "index.html")

test("Fetch brings what GitHub's branch has now", async () => {
  writeFileSync(join(there.dir, "a.txt"), "a\n")
  there.jj("commit", "-m", "Add a")
  there.jj("bookmark", "create", "topic", "-r", "@-")
  there.jj("git", "push", "--bookmark", "topic")
  const res = await fetchRepo(page, jjRun)
  expect(res.status).toBe(200)
  expect((await res.json()).output).toContain("topic@origin")
  expect(here.jj("log", "--no-graph", "-r", "topic@origin", "-T", "description")).toBe(
    "Add a\n",
  )
})

test("only a stack's page fetches, and one fetch at a time per repo", async () => {
  expect((await fetchRepo(join(here.dir, "other.html"), jjRun)).status).toBe(404)
  const go = Promise.withResolvers<void>()
  const slow: JjRun = async (cwd, ...args) => {
    await go.promise
    return jjRun(cwd, ...args)
  }
  const first = fetchRepo(page, slow)
  expect((await fetchRepo(page, jjRun)).status).toBe(409)
  go.resolve()
  expect((await first).status).toBe(200)
})

test("a fetch works in a working copy another workspace left stale", async () => {
  // second rewrites the working-copy commit of here's default workspace
  const second = join(root, "second")
  here.jj("workspace", "add", second)
  const inSecond = (...args: string[]) =>
    execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
      cwd: second,
      stdio: "pipe",
    })
  inSecond("new", "default@")
  writeFileSync(join(second, "stale.txt"), "stale\n")
  inSecond("squash", "-u", "--ignore-immutable")
  expect(() => here.jj("status")).toThrow(/stale/)
  writeFileSync(join(there.dir, "b.txt"), "b\n")
  there.jj("commit", "-m", "Add b")
  there.jj("bookmark", "create", "later", "-r", "@-")
  there.jj("git", "push", "--bookmark", "later")
  const res = await fetchRepo(page, jjRun)
  const text = await res.text()
  expect(text).not.toContain("stale")
  expect(res.status).toBe(200)
  expect(text).toContain("later@origin")
  expect(() => here.jj("status")).toThrow(/stale/)
})
