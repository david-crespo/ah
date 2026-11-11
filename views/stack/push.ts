// Pushing a stack PR's bookmark from its page, served at the page's _ah/push.
// The page's Push button only asks: the server works out from jj what the
// push would send, shows it in a sheet on the page's window (platform/ask.ts)
// and runs `jj git push` only once the person clicks Push there. A page with
// no window of ah's, like a browser tab, can't push. A push that would
// rewrite what the remote has is refused, to be pushed by hand. One push at a
// time per repo, counting the time its sheet is up.
//
// Pushing a bookmark that's new on a GitHub remote opens its PR too, once
// the push has worked, with `gh pr create`: titled and described from the
// PR's body file (data.ts), into the PR below it if that one is open on
// GitHub, else trunk. The sheet says so first, and its button says "Push and
// create PR". A PR that fails to open leaves the push standing, and the page
// shows why.
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
  STACK_FILE,
  type StackPr,
} from "./data.ts"
import { fetchPrs, type GhRun, githubRepo } from "./github.ts"
import { prBelow } from "./layout.ts"

/** What a push would send: its commits newest first, as short change ID and
 * first line of the description, and whether the bookmark is new there */
export interface Plan {
  remote: string
  tip: string
  commits: { id: string; text: string }[]
  isNew: boolean
}

/** The PR a new branch's push opens on GitHub, in `repo` (owner/name) */
export interface PrPlan {
  repo: string
  base: string
  title: string
  body: string
}

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
  if (pr) {
    notes.push(`Then a PR opens into ${pr.base}, titled:`, pr.title)
    if (!pr.body) notes.push("Its description is empty.")
  }
  return {
    heading: `Push ${bookmark} to ${plan.remote}?`,
    notes,
    rows,
    more: plan.commits.length - rows.length,
    button: pr ? "Push and create PR" : "Push",
  }
}

/** What pushing `bookmark` in the repo at `root` would send, from jj, or
 * Refused if it would rewrite what's pushed or send nothing */
export async function planPush(
  jjRun: JjRun,
  root: string,
  bookmark: string,
): Promise<Plan> {
  const log = async (revset: string, template: string) => {
    const args = [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      revset,
      "-T",
      template,
    ]
    const { success, stdout, stderr } = await jjRun(root, ...args)
    if (!success) throw new Refused(409, stderr.trim())
    return stdout.split("\n").filter(Boolean)
  }
  const tip = await tipOf(jjRun, root, bookmark)
  const remote = await pushRemote(jjRun, root)
  const local = JSON.stringify(bookmark)
  const there = `remote_bookmarks(exact:${local}, exact:${JSON.stringify(remote)})`
  const [pushed] = await log(there, `commit_id ++ "\n"`)
  if (pushed && (await log(`${there} ~ ::${local}`, `commit_id ++ "\n"`)).length)
    throw new Refused(
      409,
      `${bookmark} on ${remote} isn't an ancestor of ${bookmark} here, so pushing it would rewrite what's pushed. Push a rewrite by hand.`,
    )
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
  return { remote, tip, commits, isNew: !pushed }
}

/** The commit `bookmark` is on, after a snapshot of the working copy */
async function tipOf(jjRun: JjRun, root: string, bookmark: string): Promise<string> {
  const args = ["log", "--no-graph", "-r", JSON.stringify(bookmark), "-T", "commit_id"]
  const { success, stdout, stderr } = await jjRun(root, ...args)
  if (!success) throw new Refused(409, stderr.trim())
  return stdout
}

/** The remote `jj git push` pushes to without --remote: git.push, else the
 * only remote, else origin */
async function pushRemote(jjRun: JjRun, root: string): Promise<string> {
  const config = await jjRun(root, "--ignore-working-copy", "config", "get", "git.push")
  if (config.success) return config.stdout.trim()
  const list = await jjRun(root, "--ignore-working-copy", "git", "remote", "list")
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
  const remotes = await jjRun(root, "--ignore-working-copy", "git", "remote", "list")
  const repo = githubRepo(remotes.stdout)
  if (!repo) return null
  const stack = await readStack(pagePath)
  const row = stack.rows.find((r): r is Pr => "n" in r && r.bookmark === pr.bookmark)
  const below = row && prBelow(stack.rows, row)
  let base = stack.trunk
  if (below) {
    const github = await fetchPrs(pagePath, gh).catch((e: Error) => {
      throw new Refused(
        409,
        `couldn't ask GitHub whether ${below.bookmark} is open: ${e.message}`,
      )
    })
    if (github[below.bookmark]?.state === "OPEN") base = below.bookmark
  }
  if (!base) throw new Refused(409, `no trunk branch to open ${pr.bookmark}'s PR into`)
  return { repo, base, ...(await prText(pagePath, pr)) }
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
    if (!prPlan) return Response.json({ pushed: true, output })
    const opened = await openPr(gh, bookmark, prPlan)
    return Response.json({
      pushed: true,
      output,
      ...("url" in opened ? { pr: opened.url } : { prError: opened.error }),
    })
  } catch (e) {
    const status = e instanceof Refused ? e.status : 500
    return new Response((e as Error).message, { status })
  } finally {
    pushing.delete(repo)
  }
}
