import { expect, test } from "vitest"
import { diffMarkdown, leafBlocks } from "./diff.ts"
import { findMoves, moveBase } from "./moves.ts"
import { CASES } from "./moves_cases.ts"
import { createMarkdown } from "./render.ts"

const md = createMarkdown()
const blocksOf = (t: string) => leafBlocks(md.parse(t, { nested: true }))
/** A range's lines, without the blank ones */
const text = (t: string, [start, end]: [number, number]) =>
  t
    .split("\n")
    .slice(start, end)
    .filter((l) => l.trim())
    .join("\n")

test.each(CASES)("findMoves $name", ({ prev, next, moves }) => {
  const found = findMoves(prev, next, [blocksOf(prev), blocksOf(next)])
  expect(found.map((m) => ({ from: text(prev, m.from), to: text(next, m.to) }))).toEqual(
    moves,
  )
})

// With the moves made, the diff has only the edits left: none for blocks
// that only moved, and the rest inline
test.each(CASES.filter((c) => c.moves.length))(
  "moveBase $name",
  ({ prev, next, moves }) => {
    const base = moveBase(
      prev,
      next,
      findMoves(prev, next, [blocksOf(prev), blocksOf(next)]),
    )
    const diff = diffMarkdown(base, next, [blocksOf(base), blocksOf(next)])
    expect(diff.removed).toEqual([])
    expect(diff.added).toEqual([])
    if (moves.every((m) => m.from === m.to)) expect(diff.changes).toBe(0)
  },
)
