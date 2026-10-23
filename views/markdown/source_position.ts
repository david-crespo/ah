// Where in the source a spot in the rendered preview comes from, so ⌘-click
// can put helix's cursor there (client.ts). A block's data-line gives its
// lines; within them, the rendered text before the spot is found in the
// source with everything but letters and digits left out of both, so markup
// and hard wraps don't get in the way. Imports nothing, for tests.

export interface SourcePosition {
  /** 0-based */
  line: number
  /** 0-based, in code points */
  column: number
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c)

const wordChars = (s: string) => [...s].filter(isWordChar).join("")

/** Where `needle` ends its `nth` time in `haystack` (1-based), or -1 */
function nthEnd(haystack: string, needle: string, nth: number): number {
  let from = 0
  for (let i = 1; ; i++) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return -1
    if (i === nth) return at + needle.length
    from = at + 1
  }
}

const occurrences = (haystack: string, needle: string) => {
  let count = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1))
    count++
  return count
}

/** The spot in source lines [start, end) that `before`, the block's rendered
 * text up to the spot, leads up to: the next letter or digit after it. The
 * end of `before` is looked for in the source, as long a piece of it as is
 * there as often as in `before`, so a phrase that repeats lands on the right
 * one. A piece shorter than three characters matches too much by chance, so
 * when not even that is there, as in an embed, whose text isn't in the
 * source, it's the block's first line. */
export function sourcePosition(
  lines: string[],
  start: number,
  end: number,
  before: string,
): SourcePosition {
  let source = ""
  // The position of each of source's code units
  const at: SourcePosition[] = []
  for (let line = start; line < Math.min(end, lines.length); line++) {
    let column = 0
    for (const c of lines[line]) {
      if (isWordChar(c)) {
        source += c
        for (let i = 0; i < c.length; i++) at.push({ line, column })
      }
      column++
    }
  }
  const rendered = wordChars(before)
  if (!rendered) return { line: start, column: 0 }
  for (const size of [24, 12, 6, 3]) {
    const needle = rendered.slice(-size)
    const endsAt = nthEnd(source, needle, occurrences(rendered, needle))
    if (endsAt < 0) continue
    if (endsAt < at.length) return at[endsAt]
    const last = at[endsAt - 1]
    return { line: last.line, column: last.column + 1 }
  }
  return { line: start, column: 0 }
}
