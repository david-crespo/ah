import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { LiveDoc, splice } from "./doc.ts"

let dir: string
let docs: LiveDoc[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-doc-"))
})
afterEach(async () => {
  for (const doc of docs) doc.close()
  docs = []
  await rm(dir, { recursive: true })
})

async function markdownFile(text: string) {
  const path = join(dir, "notes.md")
  await writeFile(path, text)
  const doc = await LiveDoc.open(path)
  docs.push(doc)
  return { path, doc }
}

test("splice finds the one changed stretch", () => {
  expect(splice("the quick fox", "the slow fox")).toEqual({
    start: 4,
    delLen: 5,
    insert: "slow",
  })
  expect(splice("abc", "abc")).toEqual({ start: 3, delLen: 0, insert: "" })
  expect(splice("aa", "aaa")).toEqual({ start: 2, delLen: 0, insert: "a" })
})

test("the edit window covers every change since the last comment, once", async () => {
  const { path, doc } = await markdownFile("one two three\n")
  await writeFile(path, "one 2 three\n")
  await doc.refresh()
  await writeFile(path, "one 2 3\n")
  await doc.refresh()
  expect(doc.takeEdit()).toEqual(
    'Edit notice: since the last request, the file on disk replaced "two three" with "2 3" after "one "',
  )
  expect(doc.takeEdit()).toEqual(null)
  // Typed and undone nets out to nothing
  await writeFile(path, "one 2 3 4\n")
  await doc.refresh()
  await writeFile(path, "one 2 3\n")
  await doc.refresh()
  expect(doc.takeEdit()).toEqual(null)
})
