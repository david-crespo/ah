// Blocks that moved between two versions of a file, for the diff mode
// (diff.ts) to show once, where they are now, with a numbered placeholder
// where they were, rather than as a removal in one place and an addition in
// another. A leaf block moved when the other version has a block like it, the
// same or lightly edited, in another place. Blocks that stay in order with
// those around them haven't moved: as much text as can stays in place, so of
// two blocks that swapped, the smaller one moved, and of two the same size,
// the earlier one moved down. Blocks next to each other that moved together
// are one move.

import type { Block } from "./diff.ts"

/** A run of blocks that moved: their lines [start, end) in the old text and
 * in the new, the line of the old text it goes before to be where it is now,
 * and the line of the new text it would be before if it were where it was */
export type Move = {
  from: [number, number]
  to: [number, number]
  into: number
  was: number
}

/** The moves from `prev` to `next`, in the order of `next`. `blocks` are each
 * text's leaf blocks, as for diffMarkdown. */
export function findMoves(
  prev: string,
  next: string,
  [oldBlocks, newBlocks]: [Block[], Block[]],
): Move[] {
  const a = oldBlocks.map((b) => blockText(prev, b))
  const b = newBlocks.map((b) => blockText(next, b))
  const weight = a.map((x) => b.map((y) => similarity(x, y) * (x.size + y.size)))

  // The blocks that stay in place: the heaviest run of pairs in order in both
  // versions, by a longest common subsequence over the blocks. Each one's
  // partner in the other version, by index.
  const n = a.length
  const m = b.length
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = weight[i][j] && weight[i][j] + best[i + 1][j + 1]
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1])
    }
  }
  const stayed = [new Map<number, number>(), new Map<number, number>()]
  for (let i = 0, j = 0; i < n && j < m;) {
    if (weight[i][j] && best[i][j] === weight[i][j] + best[i + 1][j + 1]) {
      stayed[0].set(i, j)
      stayed[1].set(j, i)
      i++
      j++
    }
    // On a tie, the old block goes first: of two the same size, the earlier
    // one moved
    else if (best[i + 1][j] >= best[i][j + 1]) i++
    else j++
  }

  // Of the rest, the blocks that match another in the other version moved,
  // the closest matches first
  const taken = [new Set(stayed[0].keys()), new Set(stayed[1].keys())]
  const pairs: [number, number][] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (weight[i][j] && !taken[0].has(i) && !taken[1].has(j)) pairs.push([i, j])
    }
  }
  pairs.sort(([i, j], [k, l]) => weight[k][l] - weight[i][j])
  const moved: [number, number][] = []
  for (const [i, j] of pairs) {
    if (taken[0].has(i) || taken[1].has(j)) continue
    taken[0].add(i)
    taken[1].add(j)
    moved.push([i, j])
  }
  moved.sort(([, j], [, l]) => j - l)

  // Blocks next to each other in both versions moved together
  const runs: { i: number; j: number; length: number }[] = []
  for (const [i, j] of moved) {
    const run = runs.at(-1)
    if (run && i === run.i + run.length && j === run.j + run.length) run.length++
    else runs.push({ i, j, length: 1 })
  }

  /** Where blocks [s, e) of one version are in the other: after the partner
   * of the nearest block before them that stayed, else before the partner of
   * the nearest one after, else at the end */
  const place = (side: 0 | 1, s: number, e: number, there: Block[], text: string) => {
    for (let k = s - 1; k >= 0; k--)
      if (stayed[side].has(k)) return there[stayed[side].get(k)!].end
    for (let k = e; k < [n, m][side]; k++)
      if (stayed[side].has(k)) return there[stayed[side].get(k)!].start
    return text.split("\n").length - 1
  }
  return runs.map(({ i, j, length }) => ({
    from: [oldBlocks[i].start, oldBlocks[i + length - 1].end],
    to: [newBlocks[j].start, newBlocks[j + length - 1].end],
    into: place(1, j, j + length, oldBlocks, prev),
    was: place(0, i, i + length, newBlocks, next),
  }))
}

/** `prev` with `moves` made, as `next` has them, so a diff from it to `next`
 * shows only what changed besides. Each move takes the blank lines it has
 * around it in `next`, where the old text doesn't have them already, and
 * leaves no more than there were where it was. */
export function moveBase(prev: string, next: string, moves: Move[]): string {
  const lines = prev.split("\n")
  const nextLines = next.split("\n")
  const blank = (l: string | undefined) => l !== undefined && !l.trim()
  const cut = new Set<number>()
  for (const { from } of moves) {
    for (let l = from[0]; l < from[1]; l++) cut.add(l)
    if (from[0] === 0 || blank(lines[from[0] - 1]))
      for (let l = from[1]; blank(lines[l]); l++) cut.add(l)
  }
  /** How many blank lines go one way from line l, stopping at a cut one */
  const blanks = (all: string[], l: number, step: 1 | -1, skip = new Set<number>()) => {
    let k = 0
    while (blank(all[l + k * step]) && !skip.has(l + k * step)) k++
    return k
  }
  const out: string[] = []
  for (let l = 0; l <= lines.length; l++) {
    for (const { from, to, into } of moves) {
      if (into !== l) continue
      let after = l
      while (cut.has(after)) after++
      const before = Math.max(
        0,
        blanks(nextLines, to[0] - 1, -1) - blanks(out, out.length - 1, -1),
      )
      out.push(...Array(before).fill(""), ...lines.slice(from[0], from[1]))
      const pad = blanks(nextLines, to[1], 1) - blanks(lines, after, 1, cut)
      out.push(...Array(Math.max(0, pad)).fill(""))
    }
    if (l < lines.length && !cut.has(l)) out.push(lines[l])
  }
  return out.join("\n")
}
type Text = { text: string; size: number; words: Map<string, number>; count: number }

/** A block's lines, trimmed so indenting doesn't keep it from matching, and
 * its words */
function blockText(source: string, { start, end }: Block): Text {
  const text = source
    .split("\n")
    .slice(start, end)
    .map((l) => l.trim())
    .join("\n")
  const words = new Map<string, number>()
  const all = text.split(/\s+/).filter(Boolean)
  for (const w of all) words.set(w, (words.get(w) ?? 0) + 1)
  return { text, size: text.length, words, count: all.length }
}

// A block with fewer words matches only the same text, since a few words
// changed in a short block can make it say something else
const MIN_WORDS = 8
// The share of words two blocks must have in common to match
const CLOSE = 0.75

/** How alike two blocks are, from 0 to 1, or 0 when they don't match: the
 * share of their words they have in common */
function similarity(x: Text, y: Text): number {
  if (x.text === y.text) return 1
  if (x.count < MIN_WORDS || y.count < MIN_WORDS) return 0
  let common = 0
  for (const [w, k] of x.words) common += Math.min(k, y.words.get(w) ?? 0)
  const share = (2 * common) / (x.count + y.count)
  return share >= CLOSE ? share : 0
}
