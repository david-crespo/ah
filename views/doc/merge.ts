// Text merging for the editors in the editor pane: `ah tool doc merge` merges
// for the terminal editors, and the CodeMirror pane merges in the page
// (codemirror_pane.ts). Plain strings in and out, so it runs in both places
// and is tested without a browser.
//
// The merge is by lines, like git's, or word by word, since a markdown
// paragraph is often one long line, marking only the words both sides
// changed. See mergeDisk.

import { diffArrays } from "diff"
import { splice } from "./splice.ts"

/** A range of `a` and the range of `b` that replaces it */
type Run = { a: number; aEnd: number; b: number; bEnd: number }

/** Past this many inserted and deleted items, diff gives up on finding the
 * shortest edit and replaces everything between the common ends. Keeps the
 * time and memory of a total rewrite bounded. */
const MAX_EDITS = 1000

/** The runs that turn `a` into `b`, in order */
export function diff(a: string[], b: string[]): Run[] {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a.at(-1 - e) === b.at(-1 - e)) e++
  const ae = a.length - e
  const be = b.length - e
  if (s === ae && s === be) return []

  const changes = diffArrays(a.slice(s, ae), b.slice(s, be), { maxEditLength: MAX_EDITS })
  if (!changes) return [{ a: s, aEnd: ae, b: s, bEnd: be }]
  const runs: Run[] = []
  let x = s
  let y = s
  for (const { added, removed, count } of changes) {
    if (!added && !removed) {
      x += count
      y += count
      continue
    }
    // A removal and an addition next to each other are one replacement
    const last = runs.at(-1)
    if (!last || last.aEnd !== x || last.bEnd !== y)
      runs.push({ a: x, aEnd: x, b: y, bEnd: y })
    const run = runs.at(-1)!
    if (removed) run.aEnd = x += count
    else run.bEnd = y += count
  }
  return runs
}

/** A word: letters and digits, or a number with what's inside it, `1.50`,
 * `2026-11-09`, `10:30`. Merged a digit at a time, two edits to one number
 * would make one neither side wrote. */
const WORD = String.raw`\p{N}+(?:[.,:/-]\p{N}+)+|[\p{L}\p{N}_'’]+`
const WORDS = new RegExp(WORD, "gu")
const TOKENS = new RegExp(
  String.raw`(?:${WORD})[^\S\n]*|\n|[^\S\n]+|[^\p{L}\p{N}_'’\s][^\S\n]*`,
  "gu",
)

/** Words with their trailing spaces, other characters one at a time with
 * theirs, and newlines alone. Joined, they give back the text. */
export const tokens = (text: string): string[] => text.match(TOKENS) ?? []

/** A side's edit to the base's tokens: replace [start, end) with `insert` */
export type Hunk = { ours: boolean; start: number; end: number; insert: string[] }

/** The hunks that turn the base's tokens into a side's: a line diff, then a
 * token diff of each run of changed lines, which keeps a big rewrite fast and
 * unchanged lines anchoring the alignment */
export function hunks(base: string[], side: string[], ours: boolean): Hunk[] {
  const lines = (t: string[]) => {
    const out: string[][] = [[]]
    for (const tok of t) {
      out.at(-1)!.push(tok)
      if (tok === "\n") out.push([])
    }
    return out
  }
  const bl = lines(base)
  const sl = lines(side)
  // Where each line of the base starts, in tokens
  const starts = [0]
  for (const line of bl) starts.push(starts.at(-1)! + line.length)
  const out: Hunk[] = []
  const joined = (ls: string[][]) => ls.map((l) => l.join(""))
  for (const r of diff(joined(bl), joined(sl))) {
    const from = bl.slice(r.a, r.aEnd).flat()
    const to = sl.slice(r.b, r.bEnd).flat()
    for (const t of diff(from, to)) {
      const at = starts[r.a]
      out.push({ ours, start: at + t.a, end: at + t.aEnd, insert: to.slice(t.b, t.bEnd) })
    }
  }
  return out
}

/** Whether the hunk at [s2, e2) conflicts with [s1, e1), where an empty range
 * is an insertion. Edits that only touch don't. */
function overlaps(s1: number, e1: number, s2: number, e2: number) {
  if (s1 === e1 && s2 === e2) return s1 === s2
  if (s1 === e1) return s2 < s1 && s1 < e2
  if (s2 === e2) return s1 < s2 && s2 < e1
  return s2 < e1 && s1 < e2
}

/** A run of the base and the hunks that change it: one hunk, or several that
 * conflict */
type Region = { start: number; end: number; hunks: Hunk[] }

/** One side's version of a region */
function apply(base: string[], { start, end, hunks }: Region, ours: boolean): string {
  let out = ""
  let at = start
  for (const h of hunks) {
    if (h.ours !== ours) continue
    out += base.slice(at, h.start).join("") + h.insert.join("")
    at = h.end
  }
  return out + base.slice(at, end).join("")
}

export const words = (text: string) => text.match(WORDS)?.length ?? 0

/** Lines with their newlines. Joined, they give back the text. */
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** `disk` merged into `unsaved`, where both are edits of `base`, by lines or
 * by words, and how many conflicts it marked.
 *
 * Edits that only touch (a line or word added right after one the other side
 * changed) both go in. The same change on both sides goes in once. Any other
 * overlap is a conflict, marked with both versions, unsaved first, as git's
 * markers around the whole lines, `<<<<<<< mine`, `=======`,
 * `>>>>>>> agent`.
 *
 * By words, lines both added at one spot both go in, unsaved first, or once
 * when one side's are among the other's. A conflict within a line is marked
 * as CriticMarkup's substitution, `{~~unsaved~>disk~~}`, around the words
 * that conflict when every version is at most two words, and else around the
 * whole sentences. On a line that has that marker's syntax in it, it's marked
 * around the line. */
export function mergeDisk(
  base: string,
  unsaved: string,
  disk: string,
  by: "lines" | "words" = "words",
): { text: string; conflicts: number } {
  const split = by === "lines" ? splitLines : tokens
  // The last newline merges on its own. As a token, a side's dropping it
  // would join its last line to one the other side added after it.
  const ends = (t: string) => !t || t.endsWith("\n")
  const whole = (t: string) => (ends(t) ? t : t + "\n")
  const final = ends(unsaved) === ends(base) ? ends(disk) : ends(unsaved)
  const o = split(whole(base))
  const all = [
    ...hunks(o, split(whole(unsaved)), true),
    ...hunks(o, split(whole(disk)), false),
  ].sort(
    // At one start, an insertion goes before a replacement
    (x, y) => x.start - y.start || x.end - x.start - (y.end - y.start),
  )

  let regions: Region[] = []
  for (const h of all) {
    const last = regions.at(-1)
    if (last && overlaps(last.start, last.end, h.start, h.end)) {
      last.hunks.push(h)
      last.end = Math.max(last.end, h.end)
    } else regions.push({ start: h.start, end: h.end, hunks: [h] })
  }

  const lineStart = (i: number) => atLineStart(o, i)
  /** The whole lines that tokens [start, end) of the base are on */
  const lines = (start: number, end: number) => {
    while (!lineStart(start)) start--
    while (end < o.length && o[end - 1] !== "\n") end++
    return [start, end]
  }
  /** The base's version of a region and each side's */
  const versions = (r: Region) => ({
    orig: o.slice(r.start, r.end).join(""),
    ours: apply(o, r, true),
    theirs: apply(o, r, false),
  })
  /** A region merged, or null when it's a conflict */
  const merged = (r: Region) => {
    const { orig, ours, theirs } = versions(r)
    if (ours === theirs || theirs === orig) return ours
    if (ours === orig) return theirs
    // Lines both added at one spot. When one side's are among the other's,
    // as when it added more around a line it had already seen, that side's
    // are both.
    if (
      by === "words" &&
      r.start === r.end &&
      lineStart(r.start) &&
      ours.endsWith("\n") &&
      theirs.endsWith("\n")
    ) {
      const among = (more: string, less: string) => `\n${more}`.includes(`\n${less}`)
      return among(ours, theirs) ? ours : among(theirs, ours) ? theirs : ours + theirs
    }
    return null
  }

  /** Whether an inline marker around a region, whose versions are `texts`,
   * wouldn't read back: it would cross the cells of a table's row, or a
   * version of its lines has the marker's syntax, which would end it early
   * or start it late */
  const unmarkable = (r: Region, texts: string[]) => {
    const [start, end] = lines(r.start, r.end)
    if (o[start]?.[0] === "|" && texts.some((t) => t.includes("|"))) return true
    const hunks = all.filter((h) => start <= h.start && h.end <= end)
    return Object.values(versions({ start, end, hunks })).some((t) => SYNTAX.test(t))
  }

  // By words, conflicts across lines widen to whole lines, and ones bigger
  // than a couple of words to whole sentences
  const widen = new Map<Region, "line" | "sentence">()
  for (const r of regions) {
    if (by === "lines" || merged(r) !== null) continue
    const texts = Object.values(versions(r))
    if (texts.some((t) => t.includes("\n")) || unmarkable(r, texts)) widen.set(r, "line")
    else if (r.start < r.end && texts.some((t) => words(t) > 2)) widen.set(r, "sentence")
  }
  const boundary = (i: number) => atBoundary(o, i)
  if (widen.size) {
    const out: Region[] = []
    for (const r of regions) {
      const to = widen.get(r)
      if (to === "line") [r.start, r.end] = lines(r.start, r.end)
      else if (to === "sentence") {
        while (!boundary(r.start)) r.start--
        while (!boundary(r.end)) r.end++
      }
      // Take in the earlier regions this one now reaches, or that reach it
      while (out.length && out.at(-1)!.end > r.start) {
        const prev = out.pop()!
        r.hunks = [...prev.hunks, ...r.hunks]
        r.start = Math.min(r.start, prev.start)
        r.end = Math.max(r.end, prev.end)
        if (widen.get(prev) === "line" || widen.get(r) === "line") widen.set(r, "line")
        else if (widen.has(prev)) widen.set(r, "sentence")
      }
      out.push(r)
    }
    regions = out
  }

  let text = ""
  let at = 0
  let conflicts = 0
  for (const r of regions) {
    text += o.slice(at, r.start).join("")
    const m = merged(r)
    if (m !== null) text += m
    else {
      conflicts++
      const { ours, theirs } = versions(r)
      text +=
        by === "lines" || widen.get(r) === "line"
          ? lineMarkers(ours, theirs)
          : inlineMarkers(ours, theirs)
    }
    at = r.end
  }
  text += o.slice(at).join("")
  return { text: final ? text : text.replace(/\n$/, ""), conflicts }
}

export const atLineStart = (o: string[], i: number) => i <= 0 || o[i - 1] === "\n"

/** Whether a sentence ends right before token i of `o`, or a line, a cell of
 * a table's row, or the markers that start a line, `marker` matching a line's
 * start up to there when it's them */
export function atBoundary(o: string[], i: number, marker = MARKER): boolean {
  if (i <= 0 || i >= o.length || o[i] === "\n" || atLineStart(o, i)) return true
  let start = i
  while (!atLineStart(o, start)) start--
  if (marker.test(o.slice(start, i).join(""))) return true
  if (o[start][0] === "|" && (o[i][0] === "|" || o[i - 1][0] === "|")) return true
  const before = o.slice(Math.max(0, i - 4), i).join("")
  return (
    /[.!?]["')\]*_]*$/.test(before.trimEnd()) && (/\s$/.test(before) || /^\s/.test(o[i]))
  )
}

/** The markers that start a markdown line, one inside another: a heading's,
 * a quote's, a list item's with its checkbox, or a footnote's label */
export const LINE_MARKER =
  /^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)]|\[\^[^\]\s]+\]:)\s+(?:\[[ xX]\]\s+)?)+/
const MARKER = new RegExp(`${LINE_MARKER.source}$`)

/** `{~~ours~>theirs~~}`, with the spaces both start or end with outside */
function inlineMarkers(ours: string, theirs: string) {
  const sides = [ours, theirs].filter(Boolean)
  const same = (re: RegExp) => {
    const ws = sides.map((s) => re.exec(s)![0])
    return ws.every((w) => w === ws[0]) ? ws[0] : ""
  }
  const head = same(/^\s*/)
  const tail = same(/\s*$/)
  const strip = (s: string) => (s ? s.slice(head.length, s.length - tail.length) : s)
  return `${head}{~~${strip(ours)}~>${strip(theirs)}~~}${tail}`
}

/** The labels on git's markers, which the preview styles like the inline
 * markers and makes buttons that pick a side (preview.ts) */
export const MINE = "mine"
export const AGENT = "agent"

/** Whole lines of each side between git's markers, of seven characters or
 * the next length that no line of either side starts with, like jj's: a
 * heading's underline, or the markers of a conflict still unresolved */
function lineMarkers(ours: string, theirs: string) {
  const sides = [ours, theirs].map((s) => (s && !s.endsWith("\n") ? s + "\n" : s))
  const taken = sides
    .join("")
    .match(/^([<=>|+%-])\1{6,}/gm)
    ?.map((run) => run.length)
  let n = 7
  while (taken?.includes(n)) n++
  const mark = (ch: string, label = "") => ch.repeat(n) + label + "\n"
  return mark("<", ` ${MINE}`) + sides[0] + mark("=") + sides[1] + mark(">", ` ${AGENT}`)
}

const SYNTAX = /\{~~|~>|~~\}/
const INLINE = /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/y
const LINES = (n: number) =>
  new RegExp(
    String.raw`<{${n}} ${MINE}\n([\s\S]*?)^={${n}}\n([\s\S]*?)^>{${n}} ${AGENT}(?:\n|$)`,
    "my",
  )

/** `text` with the conflict a merge marked at `at` resolved to one side's
 * version, or null if none starts there */
export function pick(text: string, at: number, side: typeof MINE | typeof AGENT) {
  // Line markers end at the length they start with
  let n = 0
  while (text[at + n] === "<") n++
  const re = n < 7 ? INLINE : LINES(n)
  re.lastIndex = at
  const m = re.exec(text)
  return m && text.slice(0, at) + m[side === MINE ? 1 : 2] + text.slice(at + m[0].length)
}

type Change = { from: number; to: number; insert: string }

/** The changes that turn `before` into `after`, a run of whole lines each, in
 * order and as offsets into `before`, the way CodeMirror takes them. A
 * reload or merge applied this way leaves a cursor outside them where it
 * was. The CodeMirror pane uses it, and so do edit notices (doc.ts). */
export function lineChanges(before: string, after: string): Change[] {
  const lines = before.split("\n")
  const next = after.split("\n")
  // Where each line starts, and one past the end for a line after the last
  const starts = [0]
  for (const line of lines) starts.push(starts.at(-1)! + line.length + 1)
  const end = before.length
  const changes: Change[] = []
  for (const r of diff(lines, next)) {
    const from = starts[r.a]
    const insert = next.slice(r.b, r.bEnd).join("\n")
    if (r.a < r.aEnd && r.b < r.bEnd) {
      // Each run ends at a line's end, keeping its newline
      changes.push({ from, to: starts[r.aEnd] - 1, insert })
    } else if (r.b < r.bEnd) {
      changes.push(
        r.a < lines.length
          ? { from, to: from, insert: insert + "\n" }
          : { from: end, to: end, insert: "\n" + insert },
      )
    } else if (r.aEnd < lines.length) {
      changes.push({ from, to: starts[r.aEnd], insert: "" })
    } else {
      // The last lines go with the newline before them
      changes.push({ from: Math.max(0, from - 1), to: end, insert: "" })
    }
  }
  return changes
}

/** The lines of `after` that an edit of `before` changed, 0-based and
 * [start, end), each with the text it put in, for the preview to flash
 * (preview.ts). A line whose only change is its number in an ordered list
 * doesn't count, so adding or removing an item doesn't flash the items after
 * it. Lines only removed count as the line after them, to flash the block
 * they were in. */
export function editedLines(before: string, after: string) {
  const unnumbered = (line: string) => line.replace(/^(\s*)\d+(?=[.)](\s|$))/, "$1#")
  const lines = before.split("\n")
  const next = after.split("\n")
  return diff(lines.map(unnumbered), next.map(unnumbered)).map((r) => {
    const now = next.slice(r.b, r.bEnd).join("\n")
    const { start, insert } = splice(lines.slice(r.a, r.aEnd).join("\n"), now)
    const lineOf = (offset: number) => r.b + now.slice(0, offset).split("\n").length - 1
    return {
      start: lineOf(start),
      end: lineOf(start + insert.length) + 1,
      inserted: insert,
    }
  })
}
