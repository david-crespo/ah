// A stack's PRs as GitHub has them, which client.ts shows beside what jj has:
// each bookmark's newest PR, from one GraphQL query through gh. Kept for a
// few seconds, since the page asks on every jj operation and gh takes a
// second or so.

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { type Output, run } from "../../platform/proc.ts"
import { parseStackFile, STACK_FILE } from "./data.ts"

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

/** A PR's fields, and the checks on its head commit */
const PR = `number url state isDraft title baseRefName headRefOid reviewDecision
  isCrossRepository commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } }
  } } } } }`

/** Each of `count` heads' newest PRs, with an alias and a variable per
 * head: h0, h1, and so on. A few, since a head's name matches a fork's
 * branch of that name too. */
function prsQuery(count: number): string {
  const heads = Array.from({ length: count }, (_, i) => `h${i}`)
  return `query($owner: String!, $name: String!, ${heads.map((h) => `$${h}: String!`).join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${heads.map((h) => `${h}: pullRequests(headRefName: $${h}, first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR} } }`).join("\n    ")}
  }
}`
}

type PrNode = Omit<GithubPr, "checks" | "reviewDecision"> & {
  reviewDecision: string | null
  isCrossRepository: boolean
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: Check[] } } | null } }[]
  }
}

/** Running gh, which tests stand in for */
export type GhRun = (...args: string[]) => Promise<Output>

export const ghRun: GhRun = (...args) => run("gh", args)

const TTL = 15_000
const cache = new Map<string, { at: number; prs: Promise<GithubPrs> }>()

/** The PRs for the stack.json next to `pagePath` */
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

/** Ask GitHub afresh next time for the page at `pagePath`, as after a push
 * from it, which moves a branch's head there and may open a PR */
export const forgetGithub = (pagePath: string) => cache.delete(pagePath)

/** The PRs for the stack.json next to `pagePath`, asked for now */
export async function fetchPrs(pagePath: string, gh = ghRun): Promise<GithubPrs> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  // By name, since a jj workspace other than the first has no .git for gh
  const remotes = await run("jj", ["git", "remote", "list"], { cwd: root })
  const repo = githubRepo(remotes.stdout)
  // Nothing to show, as for PRs that aren't on GitHub yet
  if (!repo || !file.prs.length) return {}
  const [owner, name] = repo.split("/")
  const args = ["api", "graphql", "-f", `query=${prsQuery(file.prs.length)}`]
  args.push("-f", `owner=${owner}`, "-f", `name=${name}`)
  for (const [i, { bookmark }] of file.prs.entries()) args.push("-f", `h${i}=${bookmark}`)
  const out = await gh(...args).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e
    if (!warnedNoGh) console.error("ah: gh isn't installed, so stack pages show no PRs")
    warnedNoGh = true
    return null
  })
  if (!out) return {}
  if (!out.success) throw new Error(out.stderr.trim() || "gh api graphql failed")
  const heads: Record<string, { nodes: PrNode[] }> = JSON.parse(out.stdout).data.repository
  return Object.fromEntries(
    file.prs.flatMap(({ bookmark }, i) => {
      const pr = heads[`h${i}`].nodes.find((pr) => !pr.isCrossRepository)
      if (!pr) return []
      const { commits, reviewDecision, isCrossRepository: _, ...rest } = pr
      const checks = commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
      const github: GithubPr = {
        ...rest,
        reviewDecision: reviewDecision ?? "",
        checks: summarizeChecks(checks),
      }
      return [[bookmark, github]]
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
