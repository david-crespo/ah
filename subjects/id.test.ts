import { mkdtemp, rm } from "node:fs/promises"
import { createHmac } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { fileId, pathOf, payloadOf, signedId } from "./id.ts"

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

test("a file's id is what it was before ids held other payloads", () => {
  // As fileId made them, by hand: old URLs in open windows keep working
  const path = "/r/a/notes.md"
  const id = fileId(path)
  const sig = createHmac("sha256", readFileSync(join(dir, "ah", "url-key")))
  expect(id).toEqual(
    `notes~${Buffer.from(path).toString("base64url")}~${sig.update(path).digest("base64url").slice(0, 16)}`,
  )
})

test("a signed id holds any payload, and a changed one is refused", () => {
  const id = signedId("skepsis", '{"rev":"@"}')
  expect(payloadOf(id)).toEqual({ slug: "skepsis", payload: '{"rev":"@"}' })
  // The slug is only for reading, so what takes an id checks it
  expect(payloadOf(id.replace("skepsis", "other"))?.slug).toEqual("other")
  const [, , signature] = id.split("~")
  const other = Buffer.from('{"rev":"main"}').toString("base64url")
  expect(payloadOf(`skepsis~${other}~${signature}`)).toEqual(null)
  // Not a file's id
  expect(pathOf(id)).toEqual(null)
})
