import { expect, test } from "vitest"
import type { Pr, Shared } from "./data.ts"
import type { GithubPr } from "./github.ts"
import { arrangeRows, isCollapsed } from "./layout.ts"

const gh = (state: GithubPr["state"]) => ({ state }) as GithubPr
const pr = (n: number, rest: Partial<Pr> = {}) =>
  ({ n, tip: `b${n}`, missing: false, merged: false, commits: [], ...rest }) as Pr
const commit = { change: "c" } as Pr["commits"][number]
const shared = { head: "s", commits: [commit] } as Shared

test("a PR whose tip is gone goes last once GitHub has merged or closed it", () => {
  // As data.ts orders them: missing first, then the graph, then PRs with no
  // commits of their own
  const rows = [
    pr(5, { missing: true }),
    pr(1, { missing: true }),
    pr(4, { missing: true }),
    pr(3, { commits: [commit] }),
    shared,
    pr(2),
  ]
  const github = { b1: gh("MERGED"), b4: gh("CLOSED"), b5: gh("OPEN") }
  const order = (r: Pr | Shared) => ("n" in r ? r.n : r.head)
  expect(arrangeRows(rows, github).map(order)).toEqual([5, 3, "s", 4, 2, 1])
  // Before GitHub answers, it stays where data.ts put it
  expect(arrangeRows(rows, {}).map(order)).toEqual([5, 1, 4, 3, "s", 2])
})

test("a merged PR starts collapsed, and the user's choice wins either way", () => {
  const open = pr(1)
  expect(isCollapsed(undefined, open, gh("MERGED"))).toBe(true)
  expect(isCollapsed(undefined, open, gh("OPEN"))).toBe(false)
  expect(isCollapsed(undefined, open, gh("CLOSED"))).toBe(false)
  expect(isCollapsed(undefined, open, undefined)).toBe(false)
  // Marked merged by jjack sync, before GitHub answers
  expect(isCollapsed(undefined, pr(1, { merged: true }), undefined)).toBe(true)
  expect(isCollapsed(false, open, gh("MERGED"))).toBe(false)
  expect(isCollapsed(true, open, gh("OPEN"))).toBe(true)
})
