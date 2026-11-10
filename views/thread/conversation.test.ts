// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest"
import { findPassage } from "./conversation.ts"

beforeEach(() => (document.body.innerHTML = ""))

/** The text before a range in `content`, and the range's own */
function around(content: HTMLElement, range: Range): [string, string] {
  const before = document.createRange()
  before.setStart(content, 0)
  before.setEnd(range.startContainer, range.startOffset)
  return [before.toString(), range.toString()]
}

test("a passage is found across elements", () => {
  const content = document.createElement("article")
  content.innerHTML = "<p>The <em>quick</em> brown fox</p><p>jumps.</p>"
  const range = findPassage(content, { selection: "quick brown fox" })!
  expect(around(content, range)).toEqual(["The ", "quick brown fox"])
  expect(findPassage(content, { selection: "fox jumps" })).toBeNull()
  expect(findPassage(content, { selection: "foxjumps" })!.toString()).toBe("foxjumps")
})

test("a passage there more than once is the one with its prefix and suffix", () => {
  const content = document.createElement("article")
  content.innerHTML = "<p>one two</p><p>one three</p>"
  const range = findPassage(content, {
    selection: "one",
    prefix: "one two",
    suffix: " three",
  })!
  expect(around(content, range)).toEqual(["one two", "one"])
  expect(findPassage(content, { selection: "one", prefix: "zero " })).toBeNull()
})

test("on a page whose content is its body, not in the conversation or the comment box", () => {
  document.body.innerHTML =
    '<section id="conversation"><button>Find me</button></section>' +
    '<main><p>Find me here.</p></main><div id="popover">Find me</div>'
  const range = findPassage(document.body, { selection: "Find me" })!
  expect(range.startContainer.parentElement!.tagName).toBe("P")
  expect(findPassage(document.body, { selection: "me Find" })).toBeNull()
})
