import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { WORKSPACES_FILE } from "../workspaces/app.ts"
import { diffApp, diffArgs, type DiffSpec } from "./app.ts"

let root: string
let page: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-diff-")))
  mkdirSync(join(root, ".jj/repo"), { recursive: true })
  mkdirSync(join(root, "notes"))
  page = join(root, "notes", "index.html")
})
afterEach(() => rmSync(root, { recursive: true }))

/** The app, and the diffs it opened */
function app() {
  const opened: DiffSpec[] = []
  const routes = diffApp(async (spec) => void opened.push(spec))
  const post = (body: unknown, sub = "_ah/skepsis") =>
    routes.routes(
      sub,
      new Request("http://127.0.0.1/", { method: "POST", body: JSON.stringify(body) }),
      page,
      null,
    )
  return { opened, post }
}

test("diffArgs takes a revision or a range, and no flags", () => {
  expect(diffArgs({ rev: "ktxrpslz" })).toEqual({ rev: "ktxrpslz" })
  expect(diffArgs({ from: "one", to: "two" })).toEqual({
    from: "one",
    to: "two",
    interdiff: false,
  })
  expect(diffArgs({ from: "one", to: "two", interdiff: true })).toEqual({
    from: "one",
    to: "two",
    interdiff: true,
  })
  for (const body of [
    null,
    "ktxr",
    {},
    { rev: "" },
    { rev: "--send=sh" },
    { rev: "a b" },
    { from: "one" },
    { from: "-x", to: "two" },
    { from: "one", to: "-x" },
  ]) {
    expect(diffArgs(body)).toBeNull()
  }
})

test("a page opens diffs in its own workspace and its repo's others", async () => {
  // A secondary workspace, whose .jj/repo is a file with the repo dir's path
  const second = join(root, "second")
  mkdirSync(join(second, ".jj"), { recursive: true })
  writeFileSync(join(second, ".jj/repo"), "../../.jj/repo")
  const { opened, post } = app()
  expect((await post({ rev: "@" }))?.status).toBe(204)
  expect((await post({ cwd: second, rev: "@" }))?.status).toBe(204)
  expect(opened).toEqual([
    { cwd: root, diff: { rev: "@" }, page },
    { cwd: second, diff: { rev: "@" }, page },
  ])
  for (const cwd of ["/elsewhere", join(root, "notes"), `${root}/notes/..`, 1])
    expect((await post({ cwd, rev: "@" }))?.status).toBe(403)
  expect((await post({ rev: "-x" }))?.status).toBe(400)
  expect(await post({ rev: "@" }, "_ah/other")).toBeNull()
  expect(opened).toHaveLength(2)
})

test("a page opens diffs in the workspaces its workspaces.json lists", async () => {
  writeFileSync(
    join(root, "notes", WORKSPACES_FILE),
    JSON.stringify({ workspaces: ["/w/one"] }),
  )
  const { opened, post } = app()
  const range = { from: "a", to: "b", interdiff: true }
  expect((await post({ cwd: "/w/one", ...range }))?.status).toBe(204)
  expect(opened).toEqual([{ cwd: "/w/one", diff: range, page }])
  for (const cwd of ["/w/two", "/w/one/.."])
    expect((await post({ cwd, rev: "@" }))?.status).toBe(403)
  expect(opened).toHaveLength(1)
})

test("a workspaces.json that isn't a list of workspaces says so", async () => {
  writeFileSync(join(root, "notes", WORKSPACES_FILE), JSON.stringify({ workspaces: "/w" }))
  const res = await app().post({ cwd: "/w", rev: "@" })
  expect(res?.status).toBe(500)
  expect(await res?.text()).toContain("workspaces")
})
