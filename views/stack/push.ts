// Pushing a stack PR's bookmark from its page, served at the page's _ah/push.
// The page's Push button only asks: the server works out from jj what the
// push would send, shows it in a sheet on the page's window (platform/ask.ts)
// and runs `jj git push` only once the person clicks Push there. A page with
// no window of ah's, like a browser tab, can't push. A push that rewrites
// what the remote has, as after a rebase or an edit, is a force push, and the
// sheet says so: jj only moves a remote bookmark sideways or back when the
// remote still has it where the last fetch found it. One push at a time per
// repo, counting the time its sheet is up.
//
// Pushing a bookmark that's new on a GitHub remote opens its PR too, once
// the push has worked, with `gh pr create`: titled and described from the
// PR's body file (data.ts), into the PR below it if that one is open on
// GitHub, else trunk. The sheet says so first, and its button says "Push and
// create PR". A PR that fails to open leaves the push standing, and the page
// shows why.
//
// A PR opened into the PR below it joins that PR's GitHub stack (GitHub's
// stacked PRs), on top, when that PR is the stack's top. When the PR below
// is in no stack, a new stack is made of the open PRs under the new one,
// down to the one on trunk, and the new one, as `gh stack link` would. The
// sheet says which, or why it joins none, and a repo without stacks gets
// neither. A stack that fails to change leaves the PR standing.
//
// The push and the reads either side of the sheet snapshot the working copy,
// as a push from a terminal would: a bookmark on @ is pushed as its files
// are, and a push that rewrites @ (making it immutable, say) moves the working
// copy along rather than leaving it stale. The reads between don't need to.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import type { Confirm, Question } from "../../platform/ask.ts"
import { type JjRun, repoDir } from "../../platform/jj.ts"
import {
  type Pr,
  parseStackFile,
  prText,
  readStack,
  type Shared,
  STACK_FILE,
  type StackPr,
} from "./data.ts"
import { fetchPrs, forgetGithub, type GhRun, type GithubPrs, githubRepo } from "./github.ts"
import { prBelow } from "./layout.ts"

/** What a push would send: its commits newest first, as short change ID and
 * first line of the description, whether the bookmark is new there, and how
 * many of the commits there it replaces, if it rewrites what's pushed */
export interface Plan {
  remote: string
  tip: string
  commits: { id: string; text: string }[]
  isNew: boolean
  replaces: number
}

/** The PR a new branch's push opens on GitHub, in `repo` (owner/name), and
 * the GitHub stack it joins */
export interface PrPlan {
  repo: string
  base: string
  title: string
  body: string
  stack: StackPlan | null
}

/** How a new PR joins a GitHub stack once it's open: on top of `top`, the
 * PR below it, at the top of stack `add`; or with `create`, the open PRs
 * under it from the one on trunk up, in a new stack. `skip` says why it
 * joins none. */
export type StackPlan =
  | { add: number; top: number }
  | { create: number[] }
  | { skip: string }

/** The API version of GitHub's stacks */
const STACKS_API = "X-GitHub-Api-Version: 2026-03-10"

/** A push that won't happen, with why, as an HTTP status */
class Refused extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Repos with a push waiting on its sheet or running, by repo dir */
const pushing = new Set<string>()

/** The sheet's commit rows, at most 8 */
const SHOWN = 8

/** The sheet's question for pushing `bookmark` as `plan` says, and opening
 * the PR `pr` plans */
export function pushQuestion(
  bookmark: string,
  plan: Plan,
  pr: PrPlan | null = null,
): Question {
  const rows = plan.commits.slice(0, SHOWN)
  const notes = plan.isNew ? [`New branch on ${plan.remote}.`] : []
  if (plan.replaces)
    notes.push(
      `This rewrites ${bookmark} on ${plan.remote}, replacing ${plan.replaces} commit${plan.replaces === 1 ? "" : "s"} there.`,
    )
  if (pr) {
    notes.push(`Then a PR opens into ${pr.base}, titled:`, pr.title)
    if (!pr.body) notes.push("Its description is empty.")
    const { stack } = pr
    if (stack && "add" in stack)
      notes.push(`It goes on GitHub stack #${stack.add}, on top of #${stack.top}.`)
    else if (stack && "create" in stack)
      notes.push(
        `A GitHub stack is made of ${stack.create.map((n) => `#${n}`).join(", ")} and it.`,
      )
    else if (stack) notes.push(`It joins no GitHub stack: ${stack.skip}.`)
  }
  return {
    heading: `${plan.replaces ? "Force push" : "Push"} ${bookmark} to ${plan.remote}?`,
    notes,
    rows,
    more: plan.commits.length - rows.length,
    button: pr ? "Push and create PR" : plan.replaces ? "Force push" : "Push",
  }
}

/** What pushing `bookmark` in the repo at `root` would send, from jj, or
 * Refused if it would send nothing */
export async function planPush(
  jjRun: JjRun,
  root: string,
  bookmark: string,
): Promise<Plan> {
  const log = async (revset: string, template: string) => {
    const args = ["log", "--no-graph", "-r", revset, "-T", template]
    const { success, stdout, stderr } = await jjRun(root, ...args)
    if (!success) throw new Refused(409, stderr.trim())
    return stdout.split("\n").filter(Boolean)
  }
  const tip = await tipOf(jjRun, root, bookmark)
  const remote = await pushRemote(jjRun, root)
  const local = JSON.stringify(bookmark)
  const there = `remote_bookmarks(exact:${local}, exact:${JSON.stringify(remote)})`
  const [pushed] = await log(there, `commit_id ++ "\n"`)
  const replaces = pushed
    ? (await log(`::${there} ~ ::${local}`, `commit_id ++ "\n"`)).length
    : 0
  // Before its first push, what the remote has of it under other bookmarks
  // isn't sent
  const from = pushed ? there : `remote_bookmarks(remote=exact:${JSON.stringify(remote)})`
  const commits = (
    await log(
      `${from}..${local}`,
      `change_id.short(8) ++ " " ++ if(description, description.first_line(), "(no description)") ++ "\n"`,
    )
  ).map((line) => ({ id: line.slice(0, 8), text: line.slice(9) }))
  if (!commits.length)
    throw new Refused(409, `${bookmark} has nothing to push to ${remote}`)
  return { remote, tip, commits, isNew: !pushed, replaces }
}

/** The commit `bookmark` is on */
async function tipOf(jjRun: JjRun, root: string, bookmark: string): Promise<string> {
  const args = ["log", "--no-graph", "-r", JSON.stringify(bookmark), "-T", "commit_id"]
  const { success, stdout, stderr } = await jjRun(root, ...args)
  if (!success) throw new Refused(409, stderr.trim())
  return stdout
}

/** The remote `jj git push` pushes to without --remote: git.push, else the
 * only remote, else origin */
async function pushRemote(jjRun: JjRun, root: string): Promise<string> {
  const config = await jjRun(root, "config", "get", "git.push")
  if (config.success) return config.stdout.trim()
  const list = await jjRun(root, "git", "remote", "list")
  const remotes = list.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[0])
  if (remotes.length === 1) return remotes[0]
  if (remotes.includes("origin")) return "origin"
  throw new Refused(409, remotes.length ? "no git.push or origin remote" : "no remote")
}

/** The PR to open for `pr` once its new bookmark is pushed, or null when
 * its remote isn't on GitHub. Its base is the PR below it in the graph if
 * that one is open on GitHub, else trunk. */
export async function planPr(
  pagePath: string,
  root: string,
  pr: StackPr,
  jjRun: JjRun,
  gh: GhRun,
): Promise<PrPlan | null> {
  const remotes = await jjRun(root, "git", "remote", "list")
  const repo = githubRepo(remotes.stdout)
  if (!repo) return null
  const stack = await readStack(pagePath)
  const row = stack.rows.find((r): r is Pr => "n" in r && r.bookmark === pr.bookmark)
  const below = row && prBelow(stack.rows, row)
  let base = stack.trunk
  let joins: StackPlan | null = null
  if (below) {
    const github = await fetchPrs(pagePath, gh).catch((e: Error) => {
      throw new Refused(
        409,
        `couldn't ask GitHub whether ${below.bookmark} is open: ${e.message}`,
      )
    })
    if (github[below.bookmark]?.state === "OPEN") {
      base = below.bookmark
      joins = stackPlan(stack.rows, github, below, stack.trunk)
      if ("create" in joins) joins = await unlessNoStacks(gh, repo, joins)
    }
  }
  if (!base) throw new Refused(409, `no trunk branch to open ${pr.bookmark}'s PR into`)
  return { repo, base, ...(await prText(pagePath, pr)), stack: joins }
}

/** How a PR opened into `below`, which is open on GitHub, joins a stack
 * there: on top of `below`'s, or in a new one of the open PRs from trunk up
 * to `below` */
export function stackPlan(
  rows: (Pr | Shared)[],
  github: GithubPrs,
  below: Pr,
  trunk: string,
): StackPlan {
  const top = github[below.bookmark]
  if (top.stack)
    return top.stack.position === top.stack.size
      ? { add: top.stack.number, top: top.number }
      : { skip: `#${top.number} isn't the top of stack #${top.stack.number}` }
  const chain = [top]
  for (;;) {
    const base = chain[0].baseRefName
    if (base === trunk) return { create: chain.map((p) => p.number) }
    const row = rows.find((r): r is Pr => "n" in r && r.bookmark === base)
    const pr = row && github[row.bookmark]
    if (!pr || pr.state !== "OPEN" || chain.includes(pr))
      return {
        skip: `#${chain[0].number}'s base, ${base}, is neither ${trunk} nor an open PR here`,
      }
    if (pr.stack)
      return {
        skip: `#${pr.number} is in stack #${pr.stack.number}, but #${top.number} isn't`,
      }
    chain.unshift(pr)
  }
}

/** `plan`, or null if the repo doesn't have GitHub's stacks, which answers 404 */
async function unlessNoStacks(gh: GhRun, repo: string, plan: StackPlan) {
  const out = await gh("api", "-H", STACKS_API, `repos/${repo}/stacks?per_page=1`)
  if (out.success) return plan
  if (/\b404\b|Not Found/.test(out.stderr)) return null
  return { skip: `couldn't ask GitHub about stacks: ${out.stderr.trim()}` }
}

/** What happened when the PR at `url` joined a stack as `plan` says:
 * `{ stack }`, or `{ stackError }` */
async function joinStack(
  gh: GhRun,
  repo: string,
  url: string,
  plan: StackPlan,
): Promise<{ stack: string } | { stackError: string }> {
  if ("skip" in plan) return { stack: `In no GitHub stack: ${plan.skip}` }
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1])
  if (!n) return { stackError: `no PR number in ${url} to put in a stack` }
  const [path, prs] =
    "add" in plan
      ? [`repos/${repo}/stacks/${plan.add}/add`, [n]]
      : [`repos/${repo}/stacks`, [...plan.create, n]]
  const fields = prs.flatMap((p) => ["-F", `pull_requests[]=${p}`])
  const out = await gh("api", "-X", "POST", "-H", STACKS_API, path, ...fields)
  if (!out.success)
    return {
      stackError: `The PR isn't in a GitHub stack: ${out.stderr.trim() || "gh api failed"}`,
    }
  const { number } = JSON.parse(out.stdout) as { number: number }
  return {
    stack:
      "add" in plan
        ? `Added to GitHub stack #${number}`
        : `Made GitHub stack #${number} of ${prs.map((p) => `#${p}`).join(", ")}`,
  }
}

/** `{ url }` of the PR `plan` opens for `bookmark`, or `{ error }` */
async function openPr(
  gh: GhRun,
  bookmark: string,
  plan: PrPlan,
): Promise<{ url: string } | { error: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ah-pr-"))
  try {
    const bodyFile = join(dir, "body.md")
    await writeFile(bodyFile, plan.body)
    const out = await gh(
      "pr",
      "create",
      "--repo",
      plan.repo,
      "--head",
      bookmark,
      "--base",
      plan.base,
      "--title",
      plan.title,
      "--body-file",
      bodyFile,
    )
    if (!out.success) return { error: out.stderr.trim() || "gh pr create failed" }
    return { url: out.stdout.trim().split("\n").at(-1) ?? "" }
  } catch (e) {
    return { error: (e as Error).message }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** `{ pushed, output }` from a push of the stack PR with `bookmark`, from
 * the stack page at `pagePath`, served at `page`, once the person confirms
 * it in `confirm`, and for a new branch, `pr`, the URL of the PR it opened,
 * or `prError` */
export async function push(
  pagePath: string,
  page: URL,
  bookmark: unknown,
  confirm: Confirm,
  jjRun: JjRun,
  gh: GhRun,
): Promise<Response> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const pr = file.prs.find((p) => p.bookmark === bookmark)
  if (typeof bookmark !== "string" || !pr)
    return new Response("not a PR in this stack", { status: 404 })
  // At the root, where a terminal's push would run
  const root = rootFinder()(dir)
  if (!root) return new Response(`${dir} isn't in a jj workspace`, { status: 500 })
  const repo = repoDir(root)
  if (pushing.has(repo))
    return new Response("a push is already waiting or running in this repo", {
      status: 409,
    })
  pushing.add(repo)
  try {
    const plan = await planPush(jjRun, root, bookmark)
    const prPlan = plan.isNew ? await planPr(pagePath, root, pr, jjRun, gh) : null
    const yes = await confirm(page, pushQuestion(bookmark, plan, prPlan))
    if (yes === null)
      throw new Refused(
        409,
        "Pushing needs this page in ah's window: open it with ah tool stack",
      )
    if (!yes) return Response.json({ pushed: false, output: "cancelled" })
    // What the sheet showed is what's sent
    if ((await tipOf(jjRun, root, bookmark)) !== plan.tip)
      throw new Refused(409, `${bookmark} moved while the sheet was up; push again`)
    const out = await jjRun(
      root,
      "git",
      "push",
      "--remote",
      `exact:${plan.remote}`,
      "--bookmark",
      `exact:${bookmark}`,
    )
    if (!out.success) return new Response(out.stderr.trim(), { status: 500 })
    const output = (out.stderr + out.stdout).trim()
    // Once the PR is open too, so a read the push's jj operation set off
    // before then isn't kept
    const opened = prPlan && (await openPr(gh, bookmark, prPlan))
    const stacked =
      opened && "url" in opened && prPlan.stack
        ? await joinStack(gh, prPlan.repo, opened.url, prPlan.stack)
        : {}
    forgetGithub(pagePath)
    if (!opened) return Response.json({ pushed: true, output })
    return Response.json({
      pushed: true,
      output,
      ...("url" in opened ? { pr: opened.url } : { prError: opened.error }),
      ...stacked,
    })
  } catch (e) {
    const status = e instanceof Refused ? e.status : 500
    return new Response((e as Error).message, { status })
  } finally {
    pushing.delete(repo)
  }
}
