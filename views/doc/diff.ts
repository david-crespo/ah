// The diff mode's view of a file (preview.ts): the file's text with its
// changes since a base marked, for render.ts to show. Old and new are diffed
// the way the editor pane's merge diffs them (merge.ts), by lines and then
// words, with a cleanup pass like diff-match-patch's: a short stretch kept
// between changes joins them, more readily in a sentence, so a reworded
// stretch reads as the old words, then the new, and an addition or removal
// slides to sentence and line boundaries. A change that cuts into a code
// span or link widens to take it whole.
// A block that's mostly rewritten shows whole, old then new.
//
// A change inside a paragraph or heading is marked inline, around the new
// words, with the old words kept aside and only their index in the text. The
// marked text has the file's lines, so data-line stamps still point at the
// file. A change that crosses blocks, or is inside one that inline markers
// can't go in (a code fence or HTML), takes whole blocks: the old ones come
// back to be rendered where they were, and the new ones as line ranges. Each
// row of a table is a block of its own, so a change in a cell is marked
// inline and one across cells takes the row. One that would take a table's
// header or delimiter row, or both its rows and a block around it, takes the
// whole table. Columns added to or removed from a table are found first, by
// its header and delimiter rows (columnChanges). The diff is from a base with
// those changes made, so they're marked as columns and the rest of the
// table's changes as before.
// The markup language matters only in which lines and spans markers can't go
// in (Syntax), and in the leaf blocks the caller passes, so this diffs
// AsciiDoc (asciidoc.ts) too. Imports only merge.ts, for tests.

import { atBoundary, atLineStart, diff, hunks, LINE_MARKER, words } from "./merge.ts"

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
  /** Spans a marker can't go inside, like a code span or a link, matched
   * whole. A change that cuts into one widens to take all of it, and one
   * that takes whole spans can still be marked inline. */
  spans: RegExp
  /** Inline tags outside those spans. A change that cuts into one takes
   * its block: with a marker in it the tag wouldn't be one, and around it,
   * the marker's own tags wouldn't nest with it. */
  tags?: RegExp
}

export const MARKDOWN: Syntax = {
  lineMarker: LINE_MARKER,
  markup: /[*_`[\]()<>|\\]/,
  // Code spans, links and images, autolinks, bare URLs, and backslash
  // escapes such as `\|` in a table cell
  spans:
    /(`+)[\s\S]*?[^`]\1(?!`)|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-z][\w+.-]*:[^\s<>]*>|\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]|\\[!-/:-@[-`{-~]/gi,
  tags: /<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/gi,
}

export const ASCIIDOC: Syntax = {
  // Description list terms too, `CPU::`, which can end the line
  lineMarker:
    /^\s*(?:(?:={1,6}|\*{1,5}|-|\.{1,5}|\d+\.|<\d+>|(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):)\s+|[^\s:][^:\n]*?(?::{2,4}|;;)(?:\s+|$))(?:\[[ xX*]\]\s+)?/,
  markup: /[*_`#+^~[\]<>|\\{}]/,
  // Code and passthrough spans, macros with their targets and attributes,
  // URLs, cross references, attribute references and bracketed attributes
  spans:
    /(`+)[\s\S]*?[^`]\1(?!`)|(\+{1,3})[\s\S]*?[^+]\2(?!\+)|[\w-]+:{1,2}[^\s[\]]*\[[^\]\n]*\]|\b[a-z][\w+.-]*:\/\/[^\s[\]]+|<<[^>\n]*>>|\{[\w-]+\}|\[[^\]\n]*\]/gi,
}

/** Inline markers: OPEN, the old words' index and `}` before the new words,
 * CLOSE after them. `{` stops markdown-it's text rule, which runs over
 * anything but ASCII punctuation; the private-use characters keep them from
 * meaning anything else. */
export const OPEN = "{"
export const CLOSE = "{}"

/** A leaf block's lines, [start, end), and whether inline markers can't go
 * in it. A table's header, delimiter, and body rows are each a block, with
 * `table` set to the table's lines. The delimiter row is opaque. */
export type Block = {
  start: number
  end: number
  opaque: boolean
  table?: { start: number; end: number }
}

const LEAVES = new Set([
  "paragraph_open",
  "heading_open",
  "fence",
  "code_block",
  "html_block",
  "hr",
  "conflict",
  "gh_embed",
])
const OPAQUE = new Set(["fence", "code_block", "html_block", "conflict", "gh_embed"])

/** The leaf blocks among markdown-it's tokens for a text */
export function leafBlocks(
  tokens: { type: string; map: [number, number] | null }[],
): Block[] {
  let table: Block["table"]
  return tokens.flatMap((t) => {
    if (!t.map) return []
    const [start, end] = t.map
    if (t.type === "table_open") table = { start, end }
    if (t.type === "tr_open") {
      const row = { start, end, opaque: false, table }
      // The header row, then the delimiter row, which has no token
      return start === table?.start
        ? [row, { start: end, end: end + 1, opaque: true, table }]
        : [row]
    }
    return LEAVES.has(t.type) ? [{ start, end, opaque: OPAQUE.has(t.type) }] : []
  })
}

export type MarkdownDiff = {
  /** The new text with inline markers */
  text: string
  /** The old words of each inline marker, by index */
  old: string[]
  /** Old blocks that are gone, each to show before the new text's `line`.
   * Rows of a table that's still there go back in it. Their text has the old
   * table's header and delimiter rows first, so it parses as a table. A
   * table's removed columns have the old table's text, the columns'
   * indexes `at`, and for each old row, header first, the line it's on now in
   * `rows`, or null when it's gone. Their cells go back in the new table
   * that starts at `line`. */
  removed: {
    line: number
    text: string
    rows?: true
    columns?: { at: number[]; rows: (number | null)[] }
  }[]
  /** New blocks, as line ranges [start, end) of the new text */
  added: [number, number][]
  /** Columns new to a table, as the new table's first line and the
   * columns' indexes */
  columns: { line: number; at: number[] }[]
  /** How many changes there are */
  changes: number
}

type Table = NonNullable<Block["table"]>

/** How the columns of an old table `a` changed in the new table `b`: the
 * ones added (by their indexes in `b`), the ones removed (by their indexes
 * in `a`), or the same ones in another order */
type ColumnChange = {
  a: Table
  b: Table
  kind: "added" | "removed" | "moved"
  at: number[]
}

/** A table row's text split at the `|`s around its cells: what's before
 * the first, each cell, and what's after the last. As in GFM, every
 * unescaped `|` separates cells. */
function split(line: string): string[] {
  const out = [""]
  const t = tokens(line)
  for (const [i, tok] of t.entries())
    if (tok === "|" && t[i - 1] !== "\\") out.push("")
    else out[out.length - 1] += tok
  return out
}

/** How the columns changed from the old table's rows `a` to the new one's
 * `b`, each row split. A column is its header and delimiter cells. The
 * columns kept have the same of both in the two tables, and the ones added
 * or removed must be the only ones that get from one table's columns to the
 * other's. Null when the columns didn't change or the change is ambiguous,
 * and undefined when `b` can't be the same table. Only for tables whose rows
 * all start and end with `|` and have as many cells as the header, since an
 * empty cell at a row's edge needs its `|`. */
function columnChange(
  a: string[][],
  b: string[][],
): Omit<ColumnChange, "a" | "b"> | null | undefined {
  const piped = (rows: string[][]) =>
    rows.every(
      (r) => r.length === rows[0].length && /^[\s>]*$/.test(r[0]) && !r.at(-1)!.trim(),
    )
  if (!piped(a) || !piped(b)) return null
  const keys = (rows: string[][]) =>
    rows[0]
      .slice(1, -1)
      .map((cell, i) => JSON.stringify([cell.trim(), rows[1][i + 1].trim()]))
  const [ka, kb] = [keys(a), keys(b)]
  if (ka.length === kb.length) {
    const same = (x: string[], y: string[]) => x.join("\n") === y.join("\n")
    return !same(ka, kb) && same(ka.toSorted(), kb.toSorted())
      ? { kind: "moved", at: [] }
      : null
  }
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka]
  // ways[i][j]: the ways short[i..] is in long[j..], in order
  const ways = Array.from({ length: short.length + 1 }, (_, i) =>
    Array<number>(long.length + 1).fill(i === short.length ? 1 : 0),
  )
  for (let i = short.length - 1; i >= 0; i--)
    for (let j = long.length - 1; j >= 0; j--)
      ways[i][j] = ways[i][j + 1] + (short[i] === long[j] ? ways[i + 1][j + 1] : 0)
  if (ways[0][0] === 0) return undefined
  if (ways[0][0] > 1) return null
  const at: number[] = []
  for (let i = 0, j = 0; j < long.length; j++)
    if (i < short.length && short[i] === long[j] && ways[i + 1][j + 1]) i++
    else at.push(j)
  return { kind: ka.length < kb.length ? "added" : "removed", at }
}

/** The tables whose columns changed, each old one paired with the first new
 * one after the previous pair whose columns it could have become, and a
 * base: `prev` with the added columns put in and the removed ones taken out,
 * so a diff from it to `next` has only the tables' other changes */
function columnChanges(
  prev: string,
  next: string,
  [oldBlocks, newBlocks]: [Block[], Block[]],
): { base: string; changes: ColumnChange[] } {
  const lines = [prev.split("\n"), next.split("\n")]
  const tables = [oldBlocks, newBlocks].map((blocks) => [
    ...new Set(blocks.flatMap((b) => b.table ?? [])),
  ])
  const rows = (side: 0 | 1, t: Table) => lines[side].slice(t.start, t.end).map(split)
  const changes: ColumnChange[] = []
  let k = 0
  for (const a of tables[0]) {
    for (let j = k; j < tables[1].length; j++) {
      const b = tables[1][j]
      const change = columnChange(rows(0, a), rows(1, b))
      if (change === undefined) continue
      if (change) changes.push({ a, b, ...change })
      k = j + 1
      break
    }
  }
  const base = [...lines[0]]
  for (const { a, b, kind, at } of changes) {
    const [old, now] = [rows(0, a), rows(1, b)]
    if (kind === "removed")
      for (const [i, cells] of old.entries()) {
        for (const j of at.toReversed()) cells.splice(j + 1, 1)
        base[a.start + i] = cells.join("|")
      }
    if (kind !== "added") continue
    // An old row that matches a new one apart from the new columns gets that
    // row's cells in them. The two are then the same, so the diff lines them
    // up. Other old rows get empty cells.
    const key = (cells: string[]) => JSON.stringify(cells.map((c) => c.trim()))
    const keys = [
      old.map(key),
      now.map((cells) => key(cells.filter((_, j) => !at.includes(j - 1)))),
    ]
    const same = new Map<number, string[]>()
    let [x, y] = [0, 0]
    const pair = (end: number) => {
      while (x < end) same.set(x++, now[y++])
    }
    for (const r of diff(keys[0], keys[1])) {
      pair(r.a)
      ;[x, y] = [r.aEnd, r.bEnd]
    }
    pair(old.length)
    for (const [i, cells] of old.entries()) {
      for (const j of at) cells.splice(j + 1, 0, same.get(i)?.[j + 1] ?? " ")
      base[a.start + i] = cells.join("|")
    }
  }
  return { base: base.join("\n"), changes }
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
  /** Spans a marker can't go in, as token ranges, each inside one block */
  readonly spans: [number, number][] = []
  /** Inline tags outside them, as token ranges */
  readonly tags: [number, number][] = []

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
    // Spans are matched a block at a time: over the whole text, an unpaired
    // backtick would pair with the opening one of a later block's span
    for (const block of blocks) {
      if (block.opaque) continue
      const first = this.lineStart[block.start]
      const toks = this.t.slice(first, this.lineStart[block.end])
      // The token each character is in, to place the spans in tokens
      const tokenAt = toks.flatMap((tok, i) => Array<number>(tok.length).fill(first + i))
      const text = toks.join("")
      const range = (m: RegExpExecArray): [number, number] => [
        tokenAt[m.index],
        tokenAt[m.index + m[0].length - 1] + 1,
      ]
      const spans = [...text.matchAll(syntax.spans)].map(range)
      this.spans.push(...spans)
      for (const m of syntax.tags ? text.matchAll(syntax.tags) : []) {
        const [s, e] = range(m)
        if (!spans.some(([ss, se]) => ss <= s && e <= se)) this.tags.push([s, e])
      }
    }
  }

  /** The tokens [s, e) take, widened to the whole of each span they cut
   * into: one they overlap but don't cover, or an insertion inside one */
  cut(s: number, e: number, spans = this.spans): [number, number] {
    let [start, end] = [s, e]
    for (const [ss, se] of spans) {
      const inside = s === e ? ss < s && s < se : ss < e && s < se
      if (inside) [start, end] = [Math.min(start, ss), Math.max(end, se)]
    }
    return [start, end]
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

  /** The table, when tokens [s, e) touch only its body rows. Those rows are
   * marked one by one, whereas a change that touches a table's header or
   * delimiter row, or a block outside it, takes each table it touches whole. */
  rows(s: number, e: number): Block["table"] {
    const { blocks } = this.touched(s, e)
    const table = blocks[0]?.table
    return table && blocks.every((b) => b.table === table && b.start >= table.start + 2)
      ? table
      : undefined
  }

  /** Whether tokens [s, e) have a `|` between the cells of a table's row.
   * As in GFM, every `|` that isn't escaped separates cells, even in a code
   * span. */
  cells(s: number, e: number): boolean {
    return (
      this.touched(s, e).blocks.some((b) => b.table) &&
      this.t.slice(s, e).some((tok, k) => tok === "|" && this.t[s + k - 1] !== "\\")
    )
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
  // A table's added and removed columns are marked as columns. The diff is
  // from a base with those changes made, so it has only what changed besides.
  const { base, changes: columnsChanged } = columnChanges(prev, next, blocks)
  const o = new Side(base, blocks[0], syntax)
  const n = new Side(next, blocks[1], syntax)
  /** A line's marker, when that's all there is before token i */
  const marker = new RegExp(`(?:${syntax.lineMarker.source})$`)
  /** A line break and the marker that continues a quote on the next line */
  const continued = new RegExp(`\\n${syntax.lineMarker.source.slice(1)}`, "g")
  const trailing = new RegExp(`\\s*(?:\\n${syntax.lineMarker.source.slice(1)})?$`)
  const keys = [o.keys(), n.keys()]
  const runs: Run[] = []
  let shift = 0
  for (const h of hunks(keys[0], keys[1], true)) {
    const b = h.start + shift
    const last = runs.at(-1)
    if (last && last.aEnd === h.start && last.bEnd === b) {
      last.aEnd = h.end
      last.bEnd = b + h.insert.length
    } else
      runs.push({ a: h.start, aEnd: h.end, b, bEnd: b + h.insert.length, block: false })
    shift += h.insert.length - (h.end - h.start)
  }
  // Blank lines added or removed between blocks don't show, but in code
  // they do, and a soft break's key is a space, so a paragraph split in two
  // still shows. A side with none has nothing to be in code.
  const blank = (side: Side, k: string[], s: number, e: number) =>
    k.slice(s, e).every((key) => key === "\n") &&
    !(
      s < e &&
      side.blocks.some(
        (b) => b.opaque && b.start <= side.lineOf[s] && side.lineOf[s] < b.end,
      )
    )
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (blank(o, keys[0], r.a, r.aEnd) && blank(n, keys[1], r.b, r.bEnd)) runs.splice(i, 1)
  }

  // A shortest diff matches whatever it can, as the `.` of `end.` to one in
  // an added `...`, which splits one change into several. As in
  // diff-match-patch's cleanupSemantic, a stretch kept between two changes
  // that's no longer than either joins them. In a sentence, one no longer
  // than both together does too, so a reworded stretch reads as the old
  // words, then the new, not the two taking turns. Not across lines, which
  // the line diff already aligned, or across a table's cells, since a change
  // across a `|` takes the whole row.
  const chars = (t: string[], s: number, e: number) => t.slice(s, e).join("").length
  const size = (r: Run) => Math.max(chars(o.t, r.a, r.aEnd), chars(n.t, r.b, r.bEnd))
  const inSentence = (s: number, e: number) => {
    for (let at = s; at <= e; at++) if (atBoundary(o.t, at, marker)) return false
    return true
  }
  for (let i = 1; i < runs.length;) {
    const [prev, r] = [runs[i - 1], runs[i]]
    const gap = o.t.slice(prev.aEnd, r.a)
    const length = gap.join("").length
    const [small, big] = [size(prev), size(r)].sort((x, y) => x - y)
    if (
      !gap.includes("\n") &&
      !o.cells(prev.aEnd, r.a) &&
      (length <= small || (length <= small + big && inSentence(prev.aEnd, r.a)))
    ) {
      prev.aEnd = r.aEnd
      prev.bEnd = r.bEnd
      runs.splice(i, 1)
      i = Math.max(1, i - 1)
    } else i++
  }
  // A joined run can start or end with the same tokens on both sides. One
  // that's the same throughout goes: a line break that ended a list item and
  // now continues a paragraph has another key and the same token.
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    for (; r.a < r.aEnd && r.b < r.bEnd && o.t[r.a] === n.t[r.b]; r.b++) r.a++
    for (; r.a < r.aEnd && r.b < r.bEnd && o.t[r.aEnd - 1] === n.t[r.bEnd - 1]; r.bEnd--)
      r.aEnd--
    if (r.a === r.aEnd && r.b === r.bEnd) runs.splice(i, 1)
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
    const min = i > 0 ? runs[i - 1][e] : 0
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
  // An addition or removal that runs past a table's edge splits there, so
  // the rows in it are marked one by one and the rest doesn't take the whole
  // table
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (r.a !== r.aEnd && r.b !== r.bEnd) continue
    const [side, s, e] =
      r.a === r.aEnd ? ([n, "b", "bEnd"] as const) : ([o, "a", "aEnd"] as const)
    const edges = side.blocks
      .flatMap((b) => (b.table ? [b.table.start, b.table.end] : []))
      .map((l) => side.lineStart[l])
      .filter((at) => r[s] < at && at < r[e])
    const at = [r[s], ...new Set(edges), r[e]]
    runs.splice(i, 1, ...at.slice(1).map((end, k) => ({ ...r, [s]: at[k], [e]: end })))
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
      const [tagStart, tagEnd] = side.cut(s, e, side.tags)
      return (
        loose ||
        blocks.length > 1 ||
        blocks.some((b) => b.opaque) ||
        side.cells(s, e) ||
        side.inMarker(s, s === e) ||
        tagStart < s ||
        tagEnd > e
      )
    })
  }
  /** Whether a run should widen to whole sentences: when it has markup
   * outside the spans, which a marker could cut through */
  const needsSentences = (r: Run) => {
    const changed = texts(r).join("").replace(syntax.spans, "")
    return syntax.markup.test(changed.replace(continued, "\n"))
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
        const [s, e] = [r[key], r[key === "a" ? "aEnd" : "bEnd"]]
        const [ls, le] = side.lines(s, e)
        const { blocks } = side.touched(s, e)
        const whole = side.rows(s, e) ? [] : blocks.flatMap((b) => b.table ?? [])
        const start = Math.min(ls, ...[...blocks, ...whole].map((b) => b.start))
        const end = Math.max(le, ...[...blocks, ...whole].map((b) => b.end))
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

  // Columns in another order take the whole table, as a change to its header
  // row does, rather than a mark in each cell for the one it swapped with
  for (const { a } of columnsChanged.filter((c) => c.kind === "moved"))
    for (const r of runs)
      if (o.touched(r.a, r.aEnd).blocks.some((b) => b.table === a && b.start === a.start))
        r.block = true
  for (let i = 0; i < runs.length; i++) {
    for (;;) {
      const r = runs[i]
      if (r.block || needsBlocks(r)) {
        i = takeBlocks(i)
        break
      }
      const [a, aEnd] = o.cut(r.a, r.aEnd)
      const [b, bEnd] = n.cut(r.b, r.bEnd)
      if (a < r.a || aEnd > r.aEnd) {
        i = grow(i, "a", a, aEnd)
        continue
      }
      if (b < r.b || bEnd > r.bEnd) {
        i = grow(i, "b", b, bEnd)
        continue
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
  // Blocks changed one after another, with only blank lines kept between
  // them, read as the old ones, then the new, not the two taking turns. A
  // table's changed rows stay apart, each old row above its new one. They
  // also stay apart from the blocks around the table, which would take the
  // whole table.
  const rows = (r: Run) => o.rows(r.a, r.aEnd) ?? n.rows(r.b, r.bEnd)
  for (let i = 1; i < runs.length;) {
    const [prev, r] = [runs[i - 1], runs[i]]
    if (
      prev.block &&
      r.block &&
      !rows(prev) &&
      !rows(r) &&
      !o.t.slice(prev.aEnd, r.a).join("").trim()
    ) {
      prev.aEnd = r.aEnd
      prev.bEnd = r.bEnd
      runs.splice(i, 1)
    } else i++
  }

  // A table taken whole already has its old columns and new ones, so its
  // column changes aren't marked on their own
  const columns = columnsChanged.filter(
    ({ a, kind }) =>
      kind !== "moved" &&
      !runs.some(
        (r) => r.block && r.a <= o.lineStart[a.start] && o.lineStart[a.start] < r.aEnd,
      ),
  )
  // The cells of the added columns in the new text, as token ranges inside
  // their `|`s. Where the base has empty cells, the diff fills them in, which
  // isn't marked as a change.
  const filled: [number, number][] = []
  for (const { b, at } of columns.filter((c) => c.kind === "added"))
    for (let l = b.start; l < b.end; l++) {
      if (l === b.start + 1) continue
      const pipes: number[] = []
      for (let i = n.lineStart[l]; i < n.lineStart[l + 1]; i++)
        if (n.t[i] === "|" && n.t[i - 1] !== "\\") pipes.push(i)
      for (const i of at) filled.push([pipes[i] + 1, pipes[i + 1]])
    }
  /** Lines [start, end) of a text, with their line breaks */
  const lines = (text: string, start: number, end: number) =>
    text
      .split(/(?<=\n)/)
      .slice(start, end)
      .join("")

  const old: string[] = []
  const removed: MarkdownDiff["removed"] = []
  const added: MarkdownDiff["added"] = []
  let text = ""
  let at = 0
  let changes = 0
  for (const r of runs) {
    text += n.t.slice(at, r.b).join("")
    const [before, after] = texts(r)
    if (r.block) {
      changes++
      // The old text comes from `prev`, without the base's changes to its
      // tables, except for removed rows of a table with new columns. Those
      // come from the base, so their empty cells line up with the new ones.
      // Removed rows have the table's header and delimiter rows first, so
      // they parse as a table and go back in it (diff_view.ts).
      const table = o.rows(r.a, r.aEnd)
      const from = columns.some((c) => c.a === table && c.kind === "added") ? base : prev
      const end = r.aEnd < o.t.length ? o.lineOf[r.aEnd] : Infinity
      const gone = lines(from, o.lineOf[r.a], end)
      const line = n.lineOf[r.b]
      if (before && table)
        removed.push({
          line,
          text: lines(from, table.start, table.start + 2) + gone,
          rows: true,
        })
      else if (before) removed.push({ line, text: gone })
      if (after)
        added.push([n.lineOf[r.b], n.lineOf[r.bEnd] + (after.endsWith("\n") ? 0 : 1)])
      text += after
    } else if (!before.trim() && filled.some(([s, e]) => s <= r.b && r.bEnd <= e)) {
      text += after
    } else {
      changes++
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

  /** The new line old line `l` is on now, or null when it's gone */
  const lineNow = (l: number) => {
    const p = o.lineStart[l]
    if (runs.some((r) => r.block && r.a <= p && p < r.aEnd)) return null
    const r = runs.findLast((r) => r.aEnd <= p)
    return n.lineOf[r ? p - r.aEnd + r.bEnd : p]
  }
  const newColumns: MarkdownDiff["columns"] = []
  for (const { a, b, kind, at } of columns) {
    changes += at.length
    if (kind === "added") newColumns.push({ line: b.start, at })
    else {
      const body = Array.from({ length: a.end - a.start - 2 }, (_, i) => a.start + 2 + i)
      removed.push({
        line: b.start,
        text: lines(prev, a.start, a.end),
        columns: { at, rows: [a.start, ...body].map(lineNow) },
      })
    }
  }
  return { text, old, removed, added, columns: newColumns, changes }
}
