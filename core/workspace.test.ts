import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { openable } from "./workspace.ts"

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "ah-open-")))
  await mkdir(join(dir, "repo", ".jj"), { recursive: true })
  await mkdir(join(dir, "repo", "src"))
  await mkdir(join(dir, "a"))
})
afterEach(async () => {
  await rm(dir, { recursive: true })
})

test("open serves files under the cwd or its jj workspace, and nothing else", () => {
  const cwd = join(dir, "repo", "src")
  expect(openable(join(dir, "repo", "src", "a.md"), cwd)).toEqual(true)
  expect(openable(join(dir, "repo", ".claude", "notes", "a.md"), cwd)).toEqual(true)
  expect(openable(join(dir, "elsewhere.md"), cwd)).toEqual(false)
  expect(openable(join(dir, "repo-other", "a.md"), cwd)).toEqual(false)
  // Outside a workspace, only the cwd
  expect(openable(join(dir, "a", "b.md"), join(dir, "a"))).toEqual(true)
  expect(openable(join(dir, "b.md"), join(dir, "a"))).toEqual(false)
})

test("from a secondary workspace, open also serves the default workspace", async () => {
  await mkdir(join(dir, "repo", ".jj", "repo"))
  await mkdir(join(dir, "ws", ".jj"), { recursive: true })
  await writeFile(join(dir, "ws", ".jj", "repo"), "../../repo/.jj/repo")
  const cwd = join(dir, "ws")
  expect(openable(join(dir, "repo", ".claude", "notes", "a.md"), cwd)).toEqual(true)
  expect(openable(join(dir, "repo-other", "a.md"), cwd)).toEqual(false)
})
