// What a stack page (client.ts) does with GitHub's side once it has it: where
// a PR goes whose bookmark is gone because it merged, and which PRs start
// collapsed; which PR a PR is built on, which push.ts uses too; and when a
// push's or fetch's log can go. Kept apart from the page's drawing so it can
// be tested without a DOM.

import type { Group, Pr, Shared } from "./data.ts"
import type { GithubPr, GithubPrs } from "./github.ts"

/** Merged or closed on GitHub */
export const doneOnGithub = (gh: GithubPr | undefined) => !!gh && gh.state !== "OPEN"

/** The stack's rows, with each PR whose bookmark is gone but which GitHub
 * has merged or closed, like one whose bookmark a fetch deleted after it
 * merged, moved from the top down among the PRs with no commits of their
 * own, which come last, highest first */
export function arrangeRows(rows: (Pr | Shared)[], github: GithubPrs): (Pr | Shared)[] {
  const isPr = (row: Pr | Shared): row is Pr => "n" in row
  const gone = (row: Pr | Shared) =>
    isPr(row) && row.missing && doneOnGithub(github[row.bookmark])
  const last = (row: Pr | Shared) =>
    gone(row) || (isPr(row) && !row.missing && !row.commits.length)
  const tail = rows.filter(last) as Pr[]
  return [...rows.filter((row) => !last(row)), ...tail.sort((a, b) => b.n - a.n)]
}

/** Whether a PR is drawn collapsed: as the user last left it, else
 * collapsed once it's merged */
export const isCollapsed = (choice: boolean | undefined, gh: GithubPr | undefined) =>
  choice ?? gh?.state === "MERGED"

/** How a push or fetch from the page ended: jj's answer, and for a push
 * of a new branch, its new PR's URL or why it didn't open. `at` is when. */
export interface RunResult {
  how: "ok" | "bad" | "cancelled"
  text: string
  pr?: string
  prError?: string
  at: number
}

/** The PRs whose last run's log can go, from GitHub's side as asked for at
 * `asked`: a run that worked, once a load asked after it has the PR, so
 * the card shows where it stands, or one the user cancelled. A failure, or
 * a push whose PR didn't open, stays until the user dismisses it. */
export function settledRuns(
  runs: Map<string, unknown>,
  github: GithubPrs,
  asked: number,
): string[] {
  return [...runs]
    .filter((entry): entry is [string, RunResult] => typeof entry[1] === "object")
    .filter(([bookmark, run]) => {
      if (run.at > asked) return false
      if (run.how === "cancelled") return true
      return run.how === "ok" && !run.prError && bookmark in github
    })
    .map(([bookmark]) => bookmark)
}

/** The nearest PR under `row` in the graph, past any shared commits: one
 * its commits are built on, never one beside it on the same base */
export function prBelow(rows: (Pr | Shared)[], row: Group): Pr | undefined {
  const below = rows.find((r) => r.head === row.base)
  return below && ("n" in below ? below : prBelow(rows, below))
}
