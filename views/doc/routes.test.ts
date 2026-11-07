import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { localMedia, pickSide } from "./routes.ts"

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

test("pick: one side of a conflict, if the file is what the page showed", async () => {
  const file = join(dir, "draft.md")
  const text = "One {~~two~>2~~} three.\n"
  await writeFile(file, text)
  const post = (body: unknown) =>
    pickSide(file, new Request("http://x/", { method: "POST", body: JSON.stringify(body) }))

  expect((await post({ text, at: 0, side: "mine" })).status).toEqual(400)
  expect((await post({ text, at: 4, side: "both" })).status).toEqual(400)
  expect((await post({ text: "One.\n", at: 4, side: "mine" })).status).toEqual(400)
  expect(
    (await post({ text: "Zero {~~two~>2~~} three.\n", at: 5, side: "mine" })).status,
  ).toEqual(409)
  expect(await readFile(file, "utf8")).toEqual(text)

  expect((await post({ text, at: 4, side: "agent" })).status).toEqual(204)
  expect(await readFile(file, "utf8")).toEqual("One 2 three.\n")
})
