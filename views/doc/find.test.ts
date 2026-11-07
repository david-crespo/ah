import { expect, test } from "vitest"
import { findMatches } from "./find.ts"

test("matches across text nodes, ignoring case", () => {
  // "Some **bold** text", rendered as three text nodes
  expect(findMatches(["Some ", "bold", " text"], "e BOLD t")).toEqual([
    { start: [0, 3], end: [2, 2] },
  ])
})

test("ends a match at its node's end rather than the next node's start", () => {
  expect(findMatches(["ab", "", "cab"], "ab")).toEqual([
    { start: [0, 0], end: [0, 2] },
    { start: [2, 1], end: [2, 3] },
  ])
})

test("whitespace in the query matches a reflowed line break", () => {
  expect(findMatches(["wraps\nonto", " the next"], "wraps onto  the")).toEqual([
    { start: [0, 0], end: [1, 4] },
  ])
})

test("treats the query as text, not a pattern", () => {
  expect(findMatches(["a.b axb (c)"], "a.b")).toEqual([{ start: [0, 0], end: [0, 3] }])
  expect(findMatches(["a.b axb (c)"], "(c)")).toEqual([{ start: [0, 8], end: [0, 11] }])
})

test("finds nothing for an empty or blank query", () => {
  expect(findMatches(["some text"], "")).toEqual([])
  expect(findMatches(["some text"], "  ")).toEqual([])
})
