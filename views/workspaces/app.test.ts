import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { noteApp, WORKSPACES_FILE } from "./app.ts"

let root: string
let page: string
/** A workspace of another repo, whose notes are a link to `main`'s */
let ws: string
let main: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-note-")))
  mkdirSync(join(root, "overview"))
  page = join(root, "overview", "index.html")
  ws = join(root, "ws")
  main = join(root, "main")
  mkdirSync(join(main, ".claude/notes/tracker"), { recursive: true })
  mkdirSync(join(main, ".jj/repo"), { recursive: true })
  mkdirSync(join(ws, ".claude"), { recursive: true })
  symlinkSync(join(main, ".claude/notes"), join(ws, ".claude/notes"))
  writeFileSync(join(main, ".claude/notes/plan.md"), "")
  writeFileSync(join(main, ".claude/notes/tracker/index.html"), "")
  writeFileSync(join(main, ".claude/notes/data.json"), "")
  writeFileSync(join(main, "README.md"), "")
  symlinkSync(join(main, "README.md"), join(main, ".claude/notes/out.md"))
})
afterEach(() => rmSync(root, { recursive: true }))

const list = (workspaces: string[]) =>
  writeFileSync(join(root, "overview", WORKSPACES_FILE), JSON.stringify({ workspaces }))

/** The app, and the files it opened */
function app(from = page) {
  const opened: string[] = []
  const routes = noteApp(async (path) => void opened.push(path))
  const post = (body: unknown, sub = "_ah/doc") =>
    routes.routes(
      sub,
      new Request("http://127.0.0.1/", { method: "POST", body: JSON.stringify(body) }),
      from,
      null,
    )
  return { opened, post }
}

test("a page with no workspaces.json opens its own repo's notes, and no others", async () => {
  const { opened, post } = app(join(main, ".claude/notes/tracker/index.html"))
  expect((await post({ file: "plan.md" }))?.status).toBe(204)
  expect(opened).toEqual([join(main, ".claude/notes/plan.md")])
  expect((await post({ cwd: ws, file: "plan.md" }))?.status).toBe(403)
  // A page that's in no workspace has no repo
  expect((await app().post({ file: "plan.md" }))?.status).toBe(403)
  expect(opened).toHaveLength(1)
})

test("a page opens the notes of the workspaces it lists, by their real paths", async () => {
  list([ws])
  const { opened, post } = app()
  expect((await post({ cwd: ws, file: "plan.md" }))?.status).toBe(204)
  expect((await post({ cwd: ws, file: "tracker/index.html" }, "_ah/page"))?.status).toBe(
    204,
  )
  expect(opened).toEqual([
    join(main, ".claude/notes/plan.md"),
    join(main, ".claude/notes/tracker/index.html"),
  ])
  // main's notes are the same files, but main isn't listed
  expect((await post({ cwd: main, file: "plan.md" }))?.status).toBe(403)
  expect(opened).toHaveLength(2)
})

test("a doc is a markdown or AsciiDoc file in the notes, and a page an HTML one", async () => {
  list([ws])
  const { opened, post } = app()
  for (const file of [
    "missing.md",
    "data.json",
    "../../README.md",
    join(main, "README.md"),
    "out.md",
    "tracker",
    "tracker/index.html",
    1,
    undefined,
  ])
    expect((await post({ cwd: ws, file }))?.status).toBe(404)
  expect((await post({ cwd: ws, file: "plan.md" }, "_ah/page"))?.status).toBe(404)
  expect(await post({ cwd: ws, file: "plan.md" }, "_ah/other")).toBeNull()
  expect(opened).toEqual([])
})
