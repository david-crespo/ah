/** The single contiguous splice turning `before` into `after` (common prefix
 * and suffix), to describe a change compactly. The server and the page both
 * use it, so it imports nothing. */
export function splice(before: string, after: string) {
  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--
    endAfter--
  }
  return { start, delLen: endBefore - start, insert: after.slice(start, endAfter) }
}
