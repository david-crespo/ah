import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ghBlob, localMedia, pickSide } from "./routes.ts"

vi.mock("./github.ts", () => ({
  fetchBlob: async (...args: string[]) => args.join(" "),
  resolveAsset: async () => null,
}))

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
  for (const f of [
    "shots/a.png",
    "my shot é.png",
    ".ssh/id.png",
    ".hidden.png",
    "notes.txt",
  ]) {
    await writeFile(join(dir, f), "")
  }
  // As the renderer escapes a src, and as it's written
  for (const p of ["my%20shot%20%C3%A9.png", "my shot é.png", "shots/a.png?x=100%"])
    expect((await localMedia(draft, p)).status, p).toEqual(p.includes("?") ? 404 : 200)
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

test("gh/blob: any file name in the path, and nothing that leaves the cache", async () => {
  const blob = (path: string, owner = "o") =>
    ghBlob(new URLSearchParams({ owner, repo: "r", ref: "main", path }))
  for (const path of [
    "src/routes/+page.svelte",
    "app/(marketing)/page.tsx",
    "packages/@scope/pkg/index.ts",
    "docs/a b.md",
  ]) {
    const res = await blob(path)
    expect(res.status, path).toEqual(200)
    expect(await res.text()).toEqual(`o r main ${path}`)
  }
  for (const path of [
    "../x",
    "a/../../x",
    "a//b",
    "a/./b",
    "/etc/hosts",
    "a\\b",
    "a\0b",
    "",
  ])
    expect((await blob(path)).status, path).toEqual(400)
  expect((await blob("a.ts", "o/p")).status).toEqual(400)
  expect((await blob("a.ts", "@o")).status).toEqual(400)
})
