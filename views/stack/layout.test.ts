import { expect, test } from "vitest"
import type { Pr, Shared } from "./data.ts"
import type { GithubPr } from "./github.ts"
import { arrangeRows, isCollapsed, type RunResult, settledRuns } from "./layout.ts"

const gh = (state: GithubPr["state"]) => ({ state }) as GithubPr
const pr = (n: number, rest: Partial<Pr> = {}) =>
  ({ n, bookmark: `b${n}`, missing: false, commits: [], ...rest }) as Pr
const commit = { change: "c" } as Pr["commits"][number]
const shared = { head: "s", commits: [commit] } as Shared

test("a PR whose bookmark is gone goes last once GitHub has merged or closed it", () => {
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
  expect(isCollapsed(undefined, gh("MERGED"))).toBe(true)
  expect(isCollapsed(undefined, gh("OPEN"))).toBe(false)
  expect(isCollapsed(undefined, gh("CLOSED"))).toBe(false)
  expect(isCollapsed(undefined, undefined)).toBe(false)
  expect(isCollapsed(false, gh("MERGED"))).toBe(false)
  expect(isCollapsed(true, gh("OPEN"))).toBe(true)
})

test("a run's log goes once GitHub has the PR, unless it failed", () => {
  const run = (how: RunResult["how"], extra: Partial<RunResult> = {}): RunResult => ({
    how,
    text: "",
    at: 10,
    ...extra,
  })
  const runs = new Map<string, "pushing" | RunResult>([
    ["pushed", run("ok", { pr: "https://github.com/o/r/pull/1" })],
    ["no-pr-yet", run("ok")],
    ["pr-failed", run("ok", { prError: "gh: no auth" })],
    ["failed", run("bad")],
    ["cancelled", run("cancelled")],
    ["out", "pushing"],
  ])
  const gh = { number: 1 } as GithubPr
  const github = { pushed: gh, "pr-failed": gh, failed: gh, out: gh }
  expect(settledRuns(runs, github, 11)).toEqual(["pushed", "cancelled"])
  // A load asked before the run ended doesn't show what it did
  expect(settledRuns(runs, github, 9)).toEqual([])
})
