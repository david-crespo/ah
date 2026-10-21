import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { localMedia } from "./routes.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-markdown-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true })
})

test("local media: images and video next to the file, outside dot directories", async () => {
  const draft = join(dir, "draft.md")
  await mkdir(join(dir, "shots"))
  await mkdir(join(dir, ".ssh"))
  for (const f of ["shots/a.png", ".ssh/id.png", ".hidden.png", "notes.txt"]) {
    await writeFile(join(dir, f), "")
  }
  const shot = await localMedia(draft, "shots/a.png")
  expect(shot.status).toEqual(200)
  expect(shot.headers.get("content-type")).toEqual("image/png")
  for (const p of [
    ".ssh/id.png",
    ".hidden.png",
    "notes.txt",
    "/etc/hosts",
    "missing.png",
  ]) {
    expect((await localMedia(draft, p)).status, p).toEqual(404)
  }
})
