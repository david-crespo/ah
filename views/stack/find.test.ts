import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { findStacks } from "./file.ts"

function stack(notes: string, name: string, title: string, secondsAgo: number) {
  const dir = join(notes, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.html"), "<html>")
  writeFileSync(join(dir, "stack.json"), JSON.stringify({ title, prs: [] }))
  const t = (Date.now() - secondsAgo * 1000) / 1000
  utimesSync(join(dir, "index.html"), t, t)
  utimesSync(join(dir, "stack.json"), t, t)
}

test("finds stack pages through a symlinked notes dir, newest change first", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ah-stacks-"))
  const real = join(tmp, "real-notes")
  stack(real, "2026-11-01-old-stack", "Old", 3600)
  stack(real, "2026-11-05-new-stack", "New", 60)
  // Neither of these is a stack
  mkdirSync(join(real, "empty"))
  writeFileSync(join(real, "notes.md"), "x")
  writeFileSync(join(real, "empty", "index.html"), "<html>")
  const link = join(tmp, "link-notes")
  symlinkSync(real, link)

  const found = findStacks([link, join(tmp, "missing"), real])
  expect(found.map((s) => s.title)).toEqual(["New", "Old"])
  expect(found[0].page).toMatch(/2026-11-05-new-stack\/index\.html$/)
})

test("a stack changed by its stack.json alone sorts by that", () => {
  const notes = join(mkdtempSync(join(tmpdir(), "ah-stacks-")), "notes")
  stack(notes, "a-stack", "A", 7200)
  stack(notes, "b-stack", "B", 3600)
  const t = Date.now() / 1000
  utimesSync(join(notes, "a-stack", "stack.json"), t, t)
  expect(findStacks([notes]).map((s) => s.title)).toEqual(["A", "B"])
})
