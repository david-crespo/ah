import { expect, test } from "vitest"
import { comment, replyText } from "./cli.ts"

test("a comment names the file, the lines and the selection ahead of the text", () => {
  expect(comment("/r/a.ts", null, null, "why?")).toBe(
    "A comment from the user on /r/a.ts:\n\nwhy?",
  )
  expect(comment("/r/a.ts", [3, 3], null, "why?")).toBe(
    "A comment from the user on line 3 of /r/a.ts:\n\nwhy?",
  )
  expect(comment("/r/a.ts", [3, 5], "x = 1", "why?")).toBe(
    "A comment from the user on lines 3-5 of /r/a.ts, selecting:\n```\nx = 1\n```\n\nwhy?",
  )
})

test("a reply's text can be left out but not given empty", () => {
  expect(replyText(undefined, undefined)).toBeUndefined()
  expect(replyText("done.", undefined)).toBe("done.")
  expect(replyText(undefined, "Edited.\n\n")).toBe("Edited.")
  expect(replyText("", undefined)).toBeNull()
  expect(replyText(undefined, "")).toBeNull()
  expect(replyText(undefined, " \n")).toBeNull()
})
