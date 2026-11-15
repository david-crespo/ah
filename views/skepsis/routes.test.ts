import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { App, AppOptions } from "@oxide/skepsis"
import { afterEach, beforeEach, expect, test } from "vitest"
import { type DiffSpec, SkepsisView } from "./routes.ts"

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-skepsis-")))
  process.env.XDG_STATE_HOME = join(dir, "state")
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
  rmSync(dir, { recursive: true })
})

/** A stand-in for skepsis: each app answers with the request it saw */
function fake() {
  const made: AppOptions[] = []
  let fail = false
  const create = async (opts: AppOptions): Promise<App> => {
    made.push(opts)
    if (fail) throw new Error("no such revision")
    return {
      token: null,
      fetch: async (req) =>
        Response.json({ url: req.url, method: req.method, body: await req.text() }),
    }
  }
  return { made, create, failing: (f: boolean) => (fail = f) }
}

const spec = (rev: string): DiffSpec => ({
  cwd: "/repo",
  diff: { rev },
  page: "/repo/stack/index.html",
})
const rest = (path: string) => path.slice("/view/skepsis/".length)
const get = (view: SkepsisView, path: string, init?: RequestInit) =>
  view.handle(new Request(`http://127.0.0.1:7420${path}`, init), rest(path).split("?")[0])

test("a diff's page is served at the id open gives, and nothing else is", async () => {
  const { create } = fake()
  const view = new SkepsisView(async () => {}, create)
  const path = await view.open(spec("@"))
  expect(path).toMatch(/^\/view\/skepsis\/skepsis~[\w-]+~[\w-]+\/$/)
  expect((await get(view, path)).status).toBe(200)
  // The page's URLs are relative to it
  const bare = await get(view, path.slice(0, -1))
  expect(bare.headers.get("location")).toBe(path)
  const id = rest(path).slice(0, -1)
  const [, payload, signature] = id.split("~")
  const other = Buffer.from(JSON.stringify(spec("main"))).toString("base64url")
  for (const bad of [`skepsis~${other}~${signature}`, `other~${payload}~${signature}`])
    expect((await get(view, `/view/skepsis/${bad}/`)).status).toBe(404)
})

test("the app sees its own path, the query, and the body", async () => {
  const { create } = fake()
  const view = new SkepsisView(async () => {}, create)
  const path = await view.open(spec("@"))
  const res = await get(view, `${path}api/send?x=1`, { method: "POST", body: "hi" })
  expect(await res.json()).toEqual({
    url: "http://127.0.0.1:7420/api/send?x=1",
    method: "POST",
    body: "hi",
  })
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
})

test("the same diff has the same id and one app, and its Send goes to send", async () => {
  const { made, create } = fake()
  const sent: [DiffSpec, string][] = []
  const view = new SkepsisView(async (s, text) => void sent.push([s, text]), create)
  expect(await view.open(spec("@"))).toBe(await view.open(spec("@")))
  expect(made).toHaveLength(1)
  expect(made[0]).toMatchObject({ cwd: "/repo", vcs: "jj", revisions: "@", guard: false })
  await (made[0].send as (p: { prompt: string }) => Promise<void>)({ prompt: "fix it" })
  expect(sent).toEqual([[spec("@"), "fix it"]])
})

test("a range's diff passes from, to, and interdiff on as skepsis takes them", async () => {
  const { made, create } = fake()
  const view = new SkepsisView(async () => {}, create)
  const range = { from: "a", to: "b", interdiff: true }
  await view.open({ ...spec("@"), diff: range })
  expect(made[0]).toMatchObject({ vcs: "jj", ...range })
  expect(made[0]).not.toHaveProperty("revisions")
})

test("the 17th diff forgets the one used longest ago, which comes back on its next request", async () => {
  const { made, create } = fake()
  const view = new SkepsisView(async () => {}, create)
  const paths = []
  for (let i = 0; i < 17; i++) paths.push(await view.open(spec(`r${i}`)))
  expect(made).toHaveLength(17)
  // r0 is forgotten, and r1, used again now, outlasts r2
  await get(view, paths[1])
  await view.open(spec("r17"))
  expect(made).toHaveLength(18)
  await get(view, paths[1])
  expect(made).toHaveLength(18)
  expect((await get(view, paths[0])).status).toBe(200)
  expect(made).toHaveLength(19)
})

test("a diff that fails isn't kept", async () => {
  const { made, create, failing } = fake()
  const view = new SkepsisView(async () => {}, create)
  failing(true)
  await expect(view.open(spec("nope"))).rejects.toThrow("no such revision")
  failing(false)
  await view.open(spec("nope"))
  expect(made).toHaveLength(2)
})

test("with skepsis itself, a jj repo's diff loads", async () => {
  const repo = join(dir, "repo")
  const jj = (...args: string[]) =>
    execFileSync("jj", args, {
      cwd: repo,
      env: { ...process.env, JJ_USER: "t", JJ_EMAIL: "t@example.com" },
    })
  execFileSync("jj", ["git", "init", repo])
  writeFileSync(join(repo, "a.txt"), "hello\n")
  jj("describe", "-m", "Add a")
  const view = new SkepsisView(async () => {})
  const path = await view.open({
    cwd: repo,
    diff: { rev: "@" },
    page: join(repo, "x.html"),
  })
  const page = await get(view, path)
  expect(page.headers.get("content-type")).toContain("text/html")
  expect(await page.text()).toContain("./assets/")
  const diff = await get(view, `${path}api/diff`)
  expect(diff.status).toBe(200)
  expect(await diff.text()).toContain("a.txt")
}, 20_000)
