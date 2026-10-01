import { expect, test } from "vitest"
import { fileId } from "./id.ts"

test("fileId is the file name plus a hash of the whole path", () => {
  const id = fileId("/r/a/.claude/notes/2026-10-01-plan.md")
  expect(/^2026-10-01-plan-[0-9a-f]{8}$/.test(id)).toEqual(true)
  expect(fileId("/r/a/.claude/notes/2026-10-01-plan.md")).toEqual(id)
  expect(fileId("/r/b/.claude/notes/2026-10-01-plan.md") === id).toEqual(false)
})

test("fileId keeps URL-unsafe characters out", () => {
  expect(/^my-notes-v2-[0-9a-f]{8}$/.test(fileId("/r/my notes?v2.md"))).toEqual(true)
})

test("fileId drops whatever extension the file has", () => {
  expect(/^dash-[0-9a-f]{8}$/.test(fileId("/r/dash.html"))).toEqual(true)
})
