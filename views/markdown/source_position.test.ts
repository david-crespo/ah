import { expect, test } from "vitest"
import { sourcePosition } from "./source_position.ts"

const lines = (text: string) => text.split("\n")

test("lands on the next word in a hard-wrapped paragraph", () => {
  const src = lines("# Title\n\nThe first line wraps\nonto a second line\nand a third.")
  // The rendered paragraph reflows the three lines into one
  expect(sourcePosition(src, 2, 5, "The first line wraps onto a ")).toEqual({
    line: 3,
    column: 7,
  })
  expect(sourcePosition(src, 2, 5, "The first line wraps ")).toEqual({ line: 3, column: 0 })
})

test("mid-word", () => {
  const src = lines("alpha beta gamma")
  expect(sourcePosition(src, 0, 1, "alpha be")).toEqual({ line: 0, column: 8 })
})

test("skips markup the rendering drops", () => {
  const src = lines("See [the docs](https://example.com/docs) and **bold**\ntext here.")
  expect(sourcePosition(src, 0, 2, "See the docs and bold ")).toEqual({
    line: 1,
    column: 0,
  })
  expect(sourcePosition(src, 0, 2, "See the docs and bo")).toEqual({ line: 0, column: 49 })
})

test("a repeated phrase lands on the right occurrence", () => {
  const src = lines("one two\none two\none two")
  expect(sourcePosition(src, 0, 3, "one two one two o")).toEqual({ line: 2, column: 1 })
})

test("the block's first line when the text isn't in the source", () => {
  const src = lines("intro\n\nhttps://github.com/o/r/blob/abc/f.ts#L1-L2\n")
  expect(sourcePosition(src, 2, 3, "const x = 1")).toEqual({ line: 2, column: 0 })
  expect(sourcePosition(src, 2, 3, "")).toEqual({ line: 2, column: 0 })
})

test("past the last word", () => {
  const src = lines("last words")
  expect(sourcePosition(src, 0, 1, "last words")).toEqual({ line: 0, column: 10 })
})

test("code blocks map line for line", () => {
  const src = lines("```ts\nconst a = 1\nconst b = 2\n```")
  expect(sourcePosition(src, 0, 4, "const a = 1\nconst ")).toEqual({ line: 2, column: 6 })
})
