import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { CodeMirrorBackend, parseSave } from "./codemirror_backend.ts"

test("parseSave takes only saves", () => {
  expect(parseSave('{"type":"save","id":1,"base":"a","text":"b"}')).toEqual({
    type: "save",
    id: 1,
    base: "a",
    text: "b",
  })
  expect(parseSave('{"type":"save","id":1,"base":"a"}')).toEqual(null)
  expect(parseSave('{"type":"save","id":"1","base":"a","text":"b"}')).toEqual(null)
  expect(parseSave('{"type":"input","data":"q"}')).toEqual(null)
  expect(parseSave("null")).toEqual(null)
  expect(parseSave("{")).toEqual(null)
})

test("a save goes through only over the text it started from", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ah-cm-")), "notes.md")
  writeFileSync(file, "# notes\n")
  const backend = new CodeMirrorBackend(file)
  expect(
    await backend.save({ type: "save", id: 1, base: "# notes\n", text: "# mine\n" }),
  ).toEqual({ type: "saved", id: 1 })
  expect(readFileSync(file, "utf8")).toBe("# mine\n")
  // The agent wrote in between: the page's base is out of date
  writeFileSync(file, "# agent\n")
  expect(
    await backend.save({ type: "save", id: 2, base: "# mine\n", text: "# mine again\n" }),
  ).toEqual({ type: "stale", id: 2, text: "# agent\n" })
  expect(readFileSync(file, "utf8")).toBe("# agent\n")
})
