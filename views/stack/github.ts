// A stack's PRs as GitHub has them, which client.ts shows beside what jj has:
// each PR jjack has opened, by its number, from one GraphQL query through
// gh, with the GitHub stack it's in, if any (GitHub's stacked PRs). Kept for
// a few seconds, since the page asks on every jj operation and gh takes a
// second or so.

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { jj } from "../../platform/jj.ts"
import { type Output, run } from "../../platform/proc.ts"
import { parseStackFile, STACK_FILE } from "./data.ts"

export interface GithubPr {
  number: number
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  title: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty */
  reviewDecision: string
  /** The checks on its head, all together; null with none */
  checks: Checks | null
  /** The GitHub stack it's in, and its place there from the bottom, 1 up,
   * counting merged PRs, which stay listed; null if it's in none */
  stack: { number: number; size: number; position: number } | null
}

export type Checks = "pass" | "fail" | "pending"

/** A PR by its entry's tip; an entry with no PR isn't in it */
export type GithubPrs = Record<string, GithubPr>

/** A PR's fields, and the checks on its head commit */
const PR = `number url state isDraft title reviewDecision
  stack { number size } stackEntry { position } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } }
  } } } } }`

/** The PRs numbered by `count` variables, with an alias and a variable for
 * each: p0, p1, and so on */
function prsQuery(count: number): string {
  const prs = Array.from({ length: count }, (_, i) => `p${i}`)
  return `query($owner: String!, $name: String!, ${prs.map((p) => `$${p}: Int!`).join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${prs.map((p) => `${p}: pullRequest(number: $${p}) { ${PR} }`).join("\n    ")}
  }
}`
}

type PrNode = Omit<GithubPr, "checks" | "reviewDecision" | "stack"> & {
  reviewDecision: string | null
  stack?: { number: number; size: number } | null
  stackEntry?: { position: number } | null
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: Check[] } } | null } }[]
  }
}

/** Running gh, which tests stand in for */
export type GhRun = (...args: string[]) => Promise<Output>

export const ghRun: GhRun = (...args) => run("gh", args)

const TTL = 15_000
const cache = new Map<string, { at: number; prs: Promise<GithubPrs> }>()

/** The PRs for the stack file next to `pagePath` */
export function readGithub(pagePath: string, gh = ghRun): Promise<GithubPrs> {
  const hit = cache.get(pagePath)
  if (hit && Date.now() - hit.at < TTL) return hit.prs
  const prs = fetchPrs(pagePath, gh)
  cache.set(pagePath, { at: Date.now(), prs })
  // A failure shouldn't stick for the whole TTL
  prs.catch(() => cache.delete(pagePath))
  return prs
}

let warnedNoGh = false

/** Ask GitHub afresh next time for the page at `pagePath`, as after jjack
 * ran from it, which may have opened, moved, or merged PRs */
export const forgetGithub = (pagePath: string) => cache.delete(pagePath)

/** The PRs for the stack file next to `pagePath`, asked for now */
async function fetchPrs(pagePath: string, gh: GhRun): Promise<GithubPrs> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const opened = file.prs.filter((e) => e.pr !== undefined)
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  // By name, since a jj workspace other than the first has no .git for gh
  const repo = githubRepo(await jj(root, "git", "remote", "list"))
  // Nothing to show, as for PRs that aren't on GitHub yet
  if (!repo || !opened.length) return {}
  const [owner, name] = repo.split("/")
  const args = ["api", "graphql", "-f", `query=${prsQuery(opened.length)}`]
  args.push("-f", `owner=${owner}`, "-f", `name=${name}`)
  for (const [i, { pr }] of opened.entries()) args.push("-F", `p${i}=${pr}`)
  const out = await gh(...args).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e
    if (!warnedNoGh) console.error("ah: gh isn't installed, so stack pages show no PRs")
    warnedNoGh = true
    return null
  })
  if (!out) return {}
  // A number GitHub has no PR for is an error for its alias, with the rest
  // still in data
  const answer: { data?: { repository: Record<string, PrNode | null> } } = JSON.parse(
    out.stdout || "{}",
  )
  if (!answer.data) throw new Error(out.stderr.trim() || "gh api graphql failed")
  const prs = answer.data.repository
  return Object.fromEntries(
    opened.flatMap(({ tip }, i) => {
      const pr = prs[`p${i}`]
      if (!pr) return []
      const { commits, reviewDecision, stack, stackEntry, ...rest } = pr
      const checks = commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
      const github: GithubPr = {
        ...rest,
        reviewDecision: reviewDecision ?? "",
        checks: summarizeChecks(checks),
        stack: stack ? { ...stack, position: stackEntry?.position ?? 0 } : null,
      }
      return [[tip, github]]
    }),
  )
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
