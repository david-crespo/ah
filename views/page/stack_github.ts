// A stack's PRs as GitHub has them, which stack.ts shows beside what jj has:
// each bookmark's newest PR, from gh. Kept for a few seconds, since the page
// asks on every jj operation and gh takes a second or so.

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { run } from "../../platform/proc.ts"
import { parseStackFile, STACK_FILE } from "./stack_data.ts"

export interface GithubPr {
  number: number
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  title: string
  baseRefName: string
  headRefOid: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty */
  reviewDecision: string
  /** The checks on its head, all together; null with none */
  checks: Checks | null
}

export type Checks = "pass" | "fail" | "pending"

/** Bookmark to its newest PR; a bookmark with no PR isn't in it */
export type GithubPrs = Record<string, GithubPr>

const FIELDS =
  "number,url,state,isDraft,title,baseRefName,headRefOid,reviewDecision,statusCheckRollup"

const TTL = 15_000
const cache = new Map<string, { at: number; prs: Promise<GithubPrs> }>()

/** The PRs for the stack.json next to `pagePath` */
export function readGithub(pagePath: string): Promise<GithubPrs> {
  const hit = cache.get(pagePath)
  if (hit && Date.now() - hit.at < TTL) return hit.prs
  const prs = fetchPrs(pagePath)
  cache.set(pagePath, { at: Date.now(), prs })
  // A failure shouldn't stick for the whole TTL
  prs.catch(() => cache.delete(pagePath))
  return prs
}

let warnedNoGh = false

async function fetchPrs(pagePath: string): Promise<GithubPrs> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  // By name, since a jj workspace other than the first has no .git for gh
  const remotes = await run("jj", ["git", "remote", "list"], { cwd: root })
  const repo = githubRepo(remotes.stdout)
  // Nothing to show, as for PRs that aren't on GitHub yet
  if (!repo) return {}
  const entries = await Promise.all(
    file.prs.map(async ({ bookmark }) => {
      const args = ["pr", "list", "--repo", repo, "--head", bookmark, "--state", "all"]
      const out = await run("gh", [...args, "--limit", "1", "--json", FIELDS]).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e
          if (!warnedNoGh)
            console.error("ah: gh isn't installed, so stack pages show no PRs")
          warnedNoGh = true
          return null
        },
      )
      if (!out) return null
      if (!out.success) throw new Error(out.stderr.trim() || "gh pr list failed")
      const [pr]: (Omit<GithubPr, "checks"> & { statusCheckRollup: Check[] })[] =
        JSON.parse(out.stdout)
      if (!pr) return null
      const { statusCheckRollup, ...rest } = pr
      return [bookmark, { ...rest, checks: summarizeChecks(statusCheckRollup) }] as const
    }),
  )
  return Object.fromEntries(entries.filter((e) => e !== null))
}

/** owner/name of `origin`, or else the first GitHub remote, in
 * `jj git remote list` output */
export function githubRepo(remotes: string): string | null {
  const repos = remotes
    .split("\n")
    .map((line) =>
      line.match(/^(\S+)\s+\S*github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/),
    )
    .filter((m) => m !== null)
  return (repos.find((m) => m[1] === "origin") ?? repos[0])?.[2] ?? null
}

/** A check run has a status and conclusion; a commit status has a state */
interface Check {
  status?: string
  conclusion?: string
  state?: string
}

const FAILED = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]

export function summarizeChecks(checks: Check[]): Checks | null {
  if (!checks.length) return null
  const result = (c: Check) => c.conclusion || c.state || ""
  if (checks.some((c) => FAILED.includes(result(c)))) return "fail"
  const pending = (c: Check) =>
    (c.status !== undefined && c.status !== "COMPLETED") ||
    ["PENDING", "EXPECTED"].includes(c.state ?? "")
  return checks.some(pending) ? "pending" : "pass"
}
