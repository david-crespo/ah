// The diff mode's view of a file (preview.ts): the file's text with its
// changes since a base marked, for render.ts to show. Old and new are diffed
// the way the editor pane's merge diffs them (merge.ts), by lines and then
// words, with a cleanup pass like diff-match-patch's: a short stretch kept
// between changes joins them, and an addition or removal slides to sentence
// and line boundaries. A replacement of more than a couple of words widens
// to whole sentences, so a reworded sentence reads as the old one, then the
// new one.
// A block that's mostly rewritten shows whole, old then new.
//
// A change inside a paragraph or heading is marked inline, around the new
// words, with the old words kept aside and only their index in the text. The
// marked text has the file's lines, so data-line stamps still point at the
// file. A change that crosses blocks, or is inside one that inline markers
// can't go in (a code fence, table or HTML), takes whole blocks: the old ones
// come back to be rendered where they were, and the new ones as line ranges.
// The markup language matters only in which lines and spans markers can't go
// in (Syntax), and in the leaf blocks the caller passes, so this diffs
// AsciiDoc (asciidoc.ts) too. Imports only merge.ts, for tests.

import { atBoundary, atLineStart, hunks, words } from "./merge.ts"

/** Words, runs of space and other characters one at a time, and newlines
 * alone. Unlike the merge's tokens, space is its own token, so `end.` and the
 * `end. ` of a sentence added after it still match. */
const tokens = (text: string): string[] =>
  text.match(/[\p{L}\p{N}_'’]+|\n|[^\S\n]+|[^\p{L}\p{N}_'’\s]/gu) ?? []

/** What a markup language's syntax means for marking changes inline */
export type Syntax = {
  /** The markers that start a line's heading, list items and quotes */
  lineMarker: RegExp
  /** Inline markup, which widens a change that touches it to whole
   * sentences, so markers don't cut through it */
  markup: RegExp
  /** On a change's lines, the start of a span a marker can't go inside,
   * like a code span or a link's target, which widens it the same way */
  span: RegExp
}

export const MARKDOWN: Syntax = {
  lineMarker: /^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)+/,
  markup: /[*_`[\]()<>|\\]/,
  span: /`|\]\(/,
}

export const ASCIIDOC: Syntax = {
  // Description list terms too, `CPU::`, which can end the line
  lineMarker:
    /^\s*(?:(?:={1,6}|\*{1,5}|-|\.{1,5}|\d+\.|<\d+>|(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):)\s+|[^\s:][^:\n]*?(?::{2,4}|;;)(?:\s+|$))(?:\[[ xX*]\]\s+)?/,
  markup: /[*_`#+^~[\]<>|\\{}]/,
  // Code and passthrough spans, macros' targets and attributes, and URLs
  span: /`|\+|\[|:\/\//,
}

/** Inline markers: OPEN, the old words' index and `}` before the new words,
 * CLOSE after them. `{` stops markdown-it's text rule, which runs over
 * anything but ASCII punctuation; the private-use characters keep them from
 * meaning anything else. */
export const OPEN = "{"
export const CLOSE = "{}"

/** A leaf block's lines, [start, end), and whether inline markers can't go
 * in it */
export type Block = { start: number; end: number; opaque: boolean }

const LEAVES = new Set([
  "paragraph_open",
  "heading_open",
  "fence",
  "code_block",
  "html_block",
  "table_open",
  "hr",
  "conflict",
  "gh_embed",
])
const OPAQUE = new Set([
  "fence",
  "code_block",
  "html_block",
  "table_open",
  "conflict",
  "gh_embed",
])

/** The leaf blocks among markdown-it's tokens for a text */
export function leafBlocks(
  tokens: { type: string; map: [number, number] | null }[],
): Block[] {
  return tokens.flatMap((t) =>
    t.map && LEAVES.has(t.type)
      ? [{ start: t.map[0], end: t.map[1], opaque: OPAQUE.has(t.type) }]
      : [],
  )
}

export type MarkdownDiff = {
  /** The new text with inline markers */
  text: string
  /** The old words of each inline marker, by index */
  old: string[]
  /** Old blocks that are gone, each to show before the new text's `line` */
  removed: { line: number; text: string }[]
  /** New blocks, as line ranges [start, end) of the new text */
  added: [number, number][]
  /** How many changes there are */
  changes: number
}

/** A change: tokens [a, aEnd) of the old text became [b, bEnd) of the new.
 * Between two runs the texts are the same. */
type Run = { a: number; aEnd: number; b: number; bEnd: number; block: boolean }

/** One text's tokens and what's needed to place them in lines and blocks */
class Side {
  readonly t: string[]
  readonly blocks: Block[]
  readonly syntax: Syntax
  /** The line each token is on, with one more for the end */
  readonly lineOf: number[] = [0]
  /** The token each line starts at, with one more for the end */
  readonly lineStart: number[] = [0]

  constructor(text: string, blocks: Block[], syntax: Syntax) {
    this.t = tokens(text)
    this.blocks = blocks
    this.syntax = syntax
    for (const tok of this.t) {
      const line = this.lineOf.at(-1)! + (tok === "\n" ? 1 : 0)
      this.lineOf.push(line)
      if (tok === "\n") this.lineStart.push(this.lineOf.length - 1)
    }
    this.lineStart.push(this.t.length)
  }

  /** The lines tokens [s, e) are on: for an insertion, the line it's in,
   * or none if it's at a line's start */
  lines(s: number, e: number): [number, number] {
    const first = this.lineOf[s]
    if (e > s) return [first, this.lineOf[e - 1] + 1]
    return [first, atLineStart(this.t, s) ? first : first + 1]
  }

  /** The blocks lines [s, e) touch, and whether some of them are in none */
  touched(s: number, e: number) {
    const [ls, le] = this.lines(s, e)
    const blocks = this.blocks.filter((b) => b.start < le && b.end > ls)
    let covered = 0
    for (let l = ls; l < le; l++)
      if (blocks.some((b) => b.start <= l && l < b.end)) covered++
    return { blocks, loose: covered < le - ls }
  }

  /** What the diff compares the tokens by. A line break inside a paragraph
   * is a space, unless it's a hard break, since rewrapping doesn't show. An
   * ordered item's number is `#`, since adding an item renumbers the ones
   * after it. */
  keys(): string[] {
    const soft = new Set<number>()
    for (const b of this.blocks)
      if (!b.opaque) for (let l = b.start; l < b.end - 1; l++) soft.add(l)
    const t = this.t
    return t.map((tok, i) => {
      if (tok === "\n")
        return soft.has(this.lineOf[i]) && !/^[^\S\n]{2,}$|^[\\+]$/.test(t[i - 1] ?? "")
          ? " "
          : tok
      const numbered =
        /^\p{N}+$/u.test(tok) &&
        /^[.)]$/.test(t[i + 1] ?? "") &&
        /^\s/.test(t[i + 2] ?? "") &&
        /^[\s>]*$/.test(t.slice(this.lineStart[this.lineOf[i]], i).join(""))
      return numbered ? "#" : tok
    })
  }

  /** Whether token `i` is inside the marker that starts its line (`- `,
   * `## `, `> `) */
  inMarker(i: number, empty: boolean): boolean {
    let start = i
    while (!atLineStart(this.t, start)) start--
    let end = start
    while (end < this.t.length && this.t[end] !== "\n") end++
    const m = this.syntax.lineMarker.exec(this.t.slice(start, end).join(""))
    const at = this.t.slice(start, i).join("").length
    return m !== null && at < m[0].length && (at > 0 || !empty)
  }
}

/** `next`, the file now, marked with its changes since `prev`. `blocks` are
 * each text's leaf blocks, from the renderer's own parse, and `syntax` is
 * its markup language's. */
export function diffMarkdown(
  prev: string,
  next: string,
  blocks: [Block[], Block[]],
  syntax: Syntax = MARKDOWN,
): MarkdownDiff {
  const o = new Side(prev, blocks[0], syntax)
  const n = new Side(next, blocks[1], syntax)
  /** A line's marker, when that's all there is before token i */
  const marker = new RegExp(`(?:${syntax.lineMarker.source})$`)
  /** A line break and the marker that continues a quote on the next line */
  const continued = new RegExp(`\\n${syntax.lineMarker.source.slice(1)}`, "g")
  const trailing = new RegExp(`\\s*(?:\\n${syntax.lineMarker.source.slice(1)})?$`)
  const runs: Run[] = []
  let shift = 0
  for (const h of hunks(o.keys(), n.keys(), true)) {
    const b = h.start + shift
    const last = runs.at(-1)
    if (last && last.aEnd === h.start && last.bEnd === b) {
      last.aEnd = h.end
      last.bEnd = b + h.insert.length
    } else
      runs.push({ a: h.start, aEnd: h.end, b, bEnd: b + h.insert.length, block: false })
    shift += h.insert.length - (h.end - h.start)
  }

  // A shortest diff matches whatever it can, as the `.` of `end.` to one in
  // an added `...`, which splits one change into several. As in
  // diff-match-patch's cleanupSemantic, a stretch kept between two changes
  // that's no longer than either joins them. Not across lines, which the
  // line diff already aligned.
  const chars = (t: string[], s: number, e: number) => t.slice(s, e).join("").length
  const size = (r: Run) => Math.max(chars(o.t, r.a, r.aEnd), chars(n.t, r.b, r.bEnd))
  for (let i = 1; i < runs.length;) {
    const [prev, r] = [runs[i - 1], runs[i]]
    const gap = o.t.slice(prev.aEnd, r.a)
    const length = gap.join("").length
    if (!gap.includes("\n") && length <= size(prev) && length <= size(r)) {
      prev.aEnd = r.aEnd
      prev.bEnd = r.bEnd
      runs.splice(i, 1)
      i = Math.max(1, i - 1)
    } else i++
  }
  // A joined run can start or end with the same tokens on both sides
  for (const r of runs) {
    for (; r.a < r.aEnd && r.b < r.bEnd && o.t[r.a] === n.t[r.b]; r.b++) r.a++
    for (; r.a < r.aEnd && r.b < r.bEnd && o.t[r.aEnd - 1] === n.t[r.bEnd - 1]; r.bEnd--)
      r.aEnd--
  }

  // An addition or removal can often sit at several places, as with a
  // paragraph added after another, `\nTwo.\n` or `Two.\n\n`, or a sentence
  // added after `It ends.`, which can take the `.` and leave its own. Slide
  // it to start a line and end one where it can, as diff tools do, and else
  // to start and end at sentences.
  for (const [i, r] of runs.entries()) {
    const [side, s, e] =
      r.a === r.aEnd ? ([n, "b", "bEnd"] as const) : ([o, "a", "aEnd"] as const)
    if (r.a !== r.aEnd && r.b !== r.bEnd) continue
    const t = side.t
    const min = i > 0 ? runs[i - 1][s] : 0
    const max = i + 1 < runs.length ? runs[i + 1][s] : t.length
    const edge = (at: number) =>
      atBoundary(t, at, marker)
        ? 2
        : /\s/.test(t[at - 1] ?? "") || /\s/.test(t[at] ?? "")
          ? 1
          : 0
    // A quote's marker on a line that continues a paragraph is no place to
    // start or end, which would take the whole quote
    const cuts = (at: number) =>
      side.inMarker(at, false) && !side.blocks.some((b) => b.start === side.lineOf[at])
    const score = (start: number, end: number) =>
      10 *
        ((atLineStart(t, start) ? 4 : 0) +
          (t[start] !== "\n" ? 2 : 0) +
          (t[end - 1] === "\n" ? 1 : 0)) +
      edge(start) +
      edge(end) -
      (cuts(start) || cuts(end) ? 100 : 0)
    let best = 0
    let bestScore = score(r[s], r[e])
    for (let d = -1; r[s] + d >= min && t[r[s] + d] === t[r[e] + d]; d--) {
      if (score(r[s] + d, r[e] + d) > bestScore)
        [best, bestScore] = [d, score(r[s] + d, r[e] + d)]
    }
    for (let d = 1; r[e] + d - 1 < max && t[r[s] + d - 1] === t[r[e] + d - 1]; d++) {
      if (score(r[s] + d, r[e] + d) > bestScore)
        [best, bestScore] = [d, score(r[s] + d, r[e] + d)]
    }
    r.a += best
    r.aEnd += best
    r.b += best
    r.bEnd += best
  }

  /** Grow run i until its range on one side covers [start, end), taking in
   * the runs it reaches; returns where run i now is */
  const grow = (i: number, side: "a" | "b", start: number, end: number): number => {
    const s = side
    const e = side === "a" ? "aEnd" : "bEnd"
    const length = (side === "a" ? o : n).t.length
    let r = runs[i]
    while (r[s] > start) {
      const prev = runs[i - 1]
      const room = r[s] - (prev ? prev[e] : 0)
      const step = Math.min(room, r[s] - start)
      r.a -= step
      r.b -= step
      if (r[s] > start) {
        prev.aEnd = r.aEnd
        prev.bEnd = r.bEnd
        prev.block ||= r.block
        runs.splice(i, 1)
        i--
        r = prev
      }
    }
    while (r[e] < end) {
      const next = runs[i + 1]
      const room = (next ? next[s] : length) - r[e]
      const step = Math.min(room, end - r[e])
      r.aEnd += step
      r.bEnd += step
      if (r[e] < end) {
        r.aEnd = next.aEnd
        r.bEnd = next.bEnd
        r.block ||= next.block
        runs.splice(i + 1, 1)
      }
    }
    return i
  }

  const texts = (r: Run) => [
    o.t.slice(r.a, r.aEnd).join(""),
    n.t.slice(r.b, r.bEnd).join(""),
  ]
  /** Whether a run has to take whole blocks */
  const needsBlocks = (r: Run) => {
    const sides: [Side, number, number][] = [
      [o, r.a, r.aEnd],
      [n, r.b, r.bEnd],
    ]
    return sides.some(([side, s, e]) => {
      const { blocks, loose } = side.touched(s, e)
      return (
        loose ||
        blocks.length > 1 ||
        blocks.some((b) => b.opaque) ||
        side.inMarker(s, s === e)
      )
    })
  }
  /** Whether a run should widen to whole sentences */
  const needsSentences = (r: Run) => {
    const [before, after] = texts(r)
    // A reworded sentence, but not an addition or removal, which has no other
    // side to read against
    if (before && after && (words(before) > 2 || words(after) > 2)) return true
    if (syntax.markup.test((before + after).replace(continued, "\n"))) return true
    // Inside a code span or a link's URL, where a marker can't go
    const [ls, le] = n.lines(r.b, r.bEnd)
    const lines = n.t.slice(n.lineStart[ls], n.lineStart[le]).join("")
    return syntax.span.test(lines)
  }

  /** Grow run i to whole lines and whole blocks on both sides, until neither
   * grows; returns where it now is */
  const takeBlocks = (i: number): number => {
    runs[i].block = true
    let before: string
    do {
      before = JSON.stringify(runs[i])
      for (const [side, key] of [
        [o, "a"],
        [n, "b"],
      ] as const) {
        const r = runs[i]
        const [ls, le] = side.lines(r[key], r[key === "a" ? "aEnd" : "bEnd"])
        const { blocks } = side.touched(r[key], r[key === "a" ? "aEnd" : "bEnd"])
        const start = Math.min(ls, ...blocks.map((b) => b.start))
        const end = Math.max(le, ...blocks.map((b) => b.end))
        i = grow(
          i,
          key,
          side.lineStart[start],
          side.lineStart[Math.min(end, side.lineStart.length - 1)],
        )
      }
    } while (JSON.stringify(runs[i]) !== before)
    return i
  }

  for (let i = 0; i < runs.length; i++) {
    for (;;) {
      const r = runs[i]
      if (r.block || needsBlocks(r)) {
        i = takeBlocks(i)
        break
      }
      if (!needsSentences(r)) break
      let start = r.a
      let end = r.aEnd
      while (!atBoundary(o.t, start, marker)) start--
      while (!atBoundary(o.t, end, marker)) end++
      if (start === r.a && end === r.aEnd) break
      i = grow(i, "a", start, end)
    }
  }

  // A block that's mostly rewritten, by more than a sentence or so, reads
  // better as the old block, then the new one, than as struck and new
  // sentences taking turns
  const inBlock = new Map<Block, Run[]>()
  for (const r of runs) {
    const block = r.block ? undefined : n.touched(r.b, r.bEnd).blocks[0]
    if (block) inBlock.set(block, [...(inBlock.get(block) ?? []), r])
  }
  for (const [block, rs] of inBlock) {
    const [removed, added] = rs
      .map(texts)
      .reduce(([o, n], [before, after]) => [o + words(before), n + words(after)], [0, 0])
    const kept =
      words(n.t.slice(n.lineStart[block.start], n.lineStart[block.end]).join("")) - added
    const changed = Math.max(removed, added)
    if (changed > 12 && kept * 2 < changed) for (const r of rs) r.block = true
  }
  for (let i = 0; i < runs.length; i++) if (runs[i].block) i = takeBlocks(i)

  const old: string[] = []
  const removed: MarkdownDiff["removed"] = []
  const added: MarkdownDiff["added"] = []
  let text = ""
  let at = 0
  for (const r of runs) {
    text += n.t.slice(at, r.b).join("")
    const [before, after] = texts(r)
    if (r.block) {
      if (before) removed.push({ line: n.lineOf[r.b], text: before })
      if (after)
        added.push([n.lineOf[r.b], n.lineOf[r.bEnd] + (after.endsWith("\n") ? 0 : 1)])
      text += after
    } else {
      // Space the new words start or end with stays outside, when the old
      // ones have it too or there are none, and so does a quote's marker
      // they end with
      const space = (re: RegExp) => {
        const ws = re.exec(after)![0]
        return !before || re.exec(before)![0] === ws ? ws : ""
      }
      const head = space(/^\s*/)
      const tail = after.length > head.length ? space(trailing) : ""
      const strip = (t: string) => (t ? t.slice(head.length, t.length - tail.length) : t)
      old.push(strip(before).replace(continued, "\n"))
      text += `${head}${OPEN}${old.length - 1}}${strip(after)}${CLOSE}${tail}`
    }
    at = r.bEnd
  }
  text += n.t.slice(at).join("")
  return { text, old, removed, added, changes: runs.length }
}
