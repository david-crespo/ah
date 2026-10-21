import { mkdtemp, rm } from "node:fs/promises"
import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { fileId, pathOf } from "./id.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-id-"))
  process.env.XDG_STATE_HOME = dir
})
afterEach(async () => {
  delete process.env.XDG_STATE_HOME
  await rm(dir, { recursive: true })
})

test("an id names its file, and only ah can make one", () => {
  const path = "/r/a/.claude/notes/2026-10-01-plan.md"
  const id = fileId(path)
  expect(id.startsWith("2026-10-01-plan~")).toEqual(true)
  expect(fileId(path)).toEqual(id)
  expect(pathOf(id)).toEqual(path)
  expect(statSync(join(dir, "ah", "url-key")).mode & 0o777).toEqual(0o600)
  // Another path under the same signature, or a made-up one
  const [, , signature] = id.split("~")
  const other = Buffer.from("/Users/me/.ssh/id_ed25519").toString("base64url")
  expect(pathOf(`plan~${other}~${signature}`)).toEqual(null)
  expect(pathOf(`plan~${other}~AAAAAAAAAAAAAAAA`)).toEqual(null)
  expect(pathOf("plan-1a2b3c4d")).toEqual(null)
  expect(pathOf(`other${id.slice(id.indexOf("~"))}`)).toEqual(null)
})

test("fileId keeps URL-unsafe characters out, and drops the extension", () => {
  expect(fileId("/r/my notes?v2.md").startsWith("my-notes-v2~")).toEqual(true)
  expect(fileId("/r/dash.html").startsWith("dash~")).toEqual(true)
  expect(/^[\w.~-]+$/.test(fileId("/r/my notes?v2.md"))).toEqual(true)
})
