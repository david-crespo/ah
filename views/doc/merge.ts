// Text merging for the editors in the editor pane: the server merges for the
// terminal editors (routes.ts), and the CodeMirror pane merges in the page
// (codemirror_pane.ts). Plain strings in and out, so it runs in both places
// and is tested without a browser.
//
// The merge is by lines, like git's, or word by word, since a markdown
// paragraph is often one long line, marking only the words both sides
// changed. See mergeDisk.

import { diffArrays } from "diff"

/** A range of `a` and the range of `b` that replaces it */
type Run = { a: number; aEnd: number; b: number; bEnd: number }

/** Past this many inserted and deleted items, diff gives up on finding the
 * shortest edit and replaces everything between the common ends. Keeps the
 * time and memory of a total rewrite bounded. */
const MAX_EDITS = 1000

/** The runs that turn `a` into `b`, in order */
function diff(a: string[], b: string[]): Run[] {
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

/** Words with their trailing spaces, other characters one at a time with
 * theirs, and newlines alone. Joined, they give back the text. */
export function tokens(text: string): string[] {
  return (
    text.match(/[\p{L}\p{N}_'’]+[^\S\n]*|\n|[^\S\n]+|[^\p{L}\p{N}_'’\s][^\S\n]*/gu) ?? []
  )
}

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

export const words = (text: string) => text.match(/[\p{L}\p{N}_'’]+/gu)?.length ?? 0

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
 * By words, lines both added at one spot both go in, unsaved first, and a
 * conflict within a line is marked as CriticMarkup's substitution,
 * `{~~unsaved~>disk~~}`, around the words that conflict when every version
 * is at most two words, and else around the whole sentences. */
export function mergeDisk(
  base: string,
  unsaved: string,
  disk: string,
  by: "lines" | "words" = "words",
): { text: string; conflicts: number } {
  const split = by === "lines" ? splitLines : tokens
  const o = split(base)
  const all = [...hunks(o, split(unsaved), true), ...hunks(o, split(disk), false)].sort(
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
    // Lines both added at one spot
    if (
      by === "words" &&
      r.start === r.end &&
      lineStart(r.start) &&
      ours.endsWith("\n") &&
      theirs.endsWith("\n")
    )
      return ours + theirs
    return null
  }

  // By words, conflicts across lines widen to whole lines, and ones bigger
  // than a couple of words to whole sentences
  const widen = new Map<Region, "line" | "sentence">()
  for (const r of regions) {
    if (by === "lines" || merged(r) !== null) continue
    const all = Object.values(versions(r))
    if (all.some((t) => t.includes("\n"))) widen.set(r, "line")
    else if (r.start < r.end && all.some((t) => words(t) > 2)) widen.set(r, "sentence")
  }
  const boundary = (i: number) => atBoundary(o, i)
  if (widen.size) {
    const out: Region[] = []
    for (const r of regions) {
      const to = widen.get(r)
      if (to === "line") {
        while (!lineStart(r.start)) r.start--
        while (r.end < o.length && o[r.end - 1] !== "\n") r.end++
      } else if (to === "sentence") {
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
  return { text: text + o.slice(at).join(""), conflicts }
}

export const atLineStart = (o: string[], i: number) => i === 0 || o[i - 1] === "\n"

/** Whether a sentence ends right before token i of `o`, or a line or the
 * marker that starts a heading, list item or quote, `marker` matching a
 * line's start up to there when it's one */
export function atBoundary(o: string[], i: number, marker = MARKER): boolean {
  if (i <= 0 || i >= o.length || o[i] === "\n" || atLineStart(o, i)) return true
  let start = i
  while (!atLineStart(o, start)) start--
  if (marker.test(o.slice(start, i).join(""))) return true
  const before = o.slice(Math.max(0, i - 4), i).join("")
  return (
    /[.!?]["')\]*_]*$/.test(before.trimEnd()) && (/\s$/.test(before) || /^\s/.test(o[i]))
  )
}

/** The marker that starts a heading, list item or quote, and nothing else */
export const MARKER = /^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?$/

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

/** Whole lines of each side between git's markers */
function lineMarkers(ours: string, theirs: string) {
  const lines = (s: string) => (s && !s.endsWith("\n") ? s + "\n" : s)
  return `<<<<<<< ${MINE}\n${lines(ours)}=======\n${lines(theirs)}>>>>>>> ${AGENT}\n`
}

const INLINE = /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/y
const LINES = new RegExp(
  String.raw`<<<<<<< ${MINE}\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> ${AGENT}(?:\n|$)`,
  "my",
)

/** `text` with the conflict a merge marked at `at` resolved to one side's
 * version, or null if none starts there */
export function pick(text: string, at: number, side: typeof MINE | typeof AGENT) {
  for (const re of [INLINE, LINES]) {
    re.lastIndex = at
    const m = re.exec(text)
    if (m)
      return text.slice(0, at) + m[side === MINE ? 1 : 2] + text.slice(at + m[0].length)
  }
  return null
}

type Change = { from: number; to: number; insert: string }

/** The changes that turn `before` into `after`, a run of whole lines each, in
 * order and as offsets into `before`, the way CodeMirror takes them. A
 * reload or merge applied this way leaves a cursor outside them where it
 * was. */
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
