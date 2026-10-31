// Text merging for the editors in the editor pane: the server merges for the
// terminal editors (routes.ts), and the CodeMirror pane merges in the page
// (codemirror_pane.ts). Plain strings in and out, so it runs in both places
// and is tested without a browser.
//
// The merge is word by word, since a markdown paragraph is often one long
// line, and it never leaves conflict markers. See mergeDisk.

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
function tokens(text: string): string[] {
  return (
    text.match(/[\p{L}\p{N}_'’]+[^\S\n]*|\n|[^\S\n]+|[^\p{L}\p{N}_'’\s][^\S\n]*/gu) ?? []
  )
}

/** A side's edit to the base's tokens: replace [start, end) with `insert` */
type Hunk = { ours: boolean; start: number; end: number; insert: string[] }

/** The hunks that turn the base's tokens into a side's: a line diff, then a
 * token diff of each run of changed lines, which keeps a big rewrite fast and
 * unchanged lines anchoring the alignment */
function hunks(base: string[], side: string[], ours: boolean): Hunk[] {
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

const words = (text: string) => text.match(/[\p{L}\p{N}_'’]+/gu)?.length ?? 0

/** `disk` merged into `unsaved`, where both are edits of `base`, word by word.
 *
 * Edits that only touch (a word added right after a word the other side
 * changed) both go in. Where the edits overlap:
 *
 * - The same change on both sides goes in once.
 * - An edit wins over a deletion of the text around it.
 * - Otherwise both versions go in, unsaved first: side by side when every
 *   version of the overlap is at most two words ("fast inexpensive"), and
 *   else as both versions of the whole sentence, one after the other (one
 *   line each for a heading or list item). */
export function mergeDisk(base: string, unsaved: string, disk: string): string {
  const o = tokens(base)
  const all = [...hunks(o, tokens(unsaved), true), ...hunks(o, tokens(disk), false)].sort(
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

  // Conflicts bigger than a couple of words widen to whole sentences
  const widened = new Set<Region>()
  for (const r of regions) {
    if (new Set(r.hunks.map((h) => h.ours)).size < 2 || r.start === r.end) continue
    const ours = apply(o, r, true)
    const theirs = apply(o, r, false)
    if (ours === theirs) continue
    const orig = o.slice(r.start, r.end).join("")
    if ([orig, ours, theirs].some((t) => words(t) > 2)) widened.add(r)
  }
  // Whether a sentence or line ends right before token i
  const boundary = (i: number) => {
    if (i <= 0 || i >= o.length || o[i] === "\n" || o[i - 1] === "\n") return true
    const before = o.slice(Math.max(0, i - 4), i).join("")
    return (
      /[.!?]["')\]*_]*$/.test(before.trimEnd()) && (/\s$/.test(before) || /^\s/.test(o[i]))
    )
  }
  if (widened.size) {
    const out: Region[] = []
    for (const r of regions) {
      if (widened.has(r)) {
        while (!boundary(r.start)) r.start--
        while (!boundary(r.end)) r.end++
      }
      // Take in the earlier regions this one now reaches, or that reach it
      while (out.length && out.at(-1)!.end > r.start) {
        const prev = out.pop()!
        r.hunks = [...prev.hunks, ...r.hunks]
        r.start = Math.min(r.start, prev.start)
        r.end = Math.max(r.end, prev.end)
        if (widened.has(prev)) widened.add(r)
      }
      out.push(r)
    }
    regions = out
  }

  let text = ""
  let at = 0
  for (const r of regions) {
    text += o.slice(at, r.start).join("")
    const ours = apply(o, r, true)
    const theirs = apply(o, r, false)
    const orig = o.slice(r.start, r.end).join("")
    if (ours === theirs || theirs === orig) text += ours
    else if (ours === orig) text += theirs
    else {
      const block = widened.has(r) && /^\s*(?:#|>|\||[-*+]\s|\d+[.)]\s)/.test(ours)
      text += join(ours, theirs, block ? "\n" : " ")
    }
    at = r.end
  }
  return text + o.slice(at).join("")
}

/** Two versions one after the other, with `sep` between if they'd otherwise
 * run together */
function join(a: string, b: string, sep: string) {
  if (!a || !b) return a + b
  return /\s$/.test(a) || /^[\s,.;:!?)\]]/.test(b) ? a + b : a + sep + b
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
