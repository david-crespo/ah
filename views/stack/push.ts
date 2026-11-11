// Pushing a stack PR's bookmark from its page, served at the page's _ah/push.
// The page's Push button only asks: the server works out from jj what the
// push would send, shows it in a sheet on the page's window (platform/ask.ts)
// and runs `jj git push` only once the person clicks Push there. A page with
// no window of ah's, like a browser tab, can't push. A push that would
// rewrite what the remote has is refused, to be pushed by hand. One push at a
// time per repo, counting the time its sheet is up.
//
// The push and the reads either side of the sheet snapshot the working copy,
// as a push from a terminal would: a bookmark on @ is pushed as its files
// are, and a push that rewrites @ (making it immutable, say) moves the working
// copy along rather than leaving it stale. The reads between don't need to.

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import type { Confirm, Question } from "../../platform/ask.ts"
import { type JjRun, repoDir } from "../../platform/jj.ts"
import { parseStackFile, STACK_FILE } from "./data.ts"

/** What a push would send: its commits newest first, as short change ID and
 * first line of the description, and whether the bookmark is new there */
export interface Plan {
  remote: string
  tip: string
  commits: { id: string; text: string }[]
  isNew: boolean
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

/** The sheet's question for pushing `bookmark` as `plan` says */
export function pushQuestion(bookmark: string, plan: Plan): Question {
  const rows = plan.commits.slice(0, SHOWN)
  return {
    heading: `Push ${bookmark} to ${plan.remote}?`,
    notes: plan.isNew ? [`New branch on ${plan.remote}.`] : [],
    rows,
    more: plan.commits.length - rows.length,
    button: "Push",
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

/** `{ pushed, output }` from a push of the stack PR with `bookmark`, from
 * the stack page at `pagePath`, served at `page`, once the person confirms
 * it in `confirm` */
export async function push(
  pagePath: string,
  page: URL,
  bookmark: unknown,
  confirm: Confirm,
  jjRun: JjRun,
): Promise<Response> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  if (typeof bookmark !== "string" || !file.prs.some((pr) => pr.bookmark === bookmark))
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
    const yes = await confirm(page, pushQuestion(bookmark, plan))
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
    return Response.json({ pushed: true, output: (out.stderr + out.stdout).trim() })
  } catch (e) {
    const status = e instanceof Refused ? e.status : 500
    return new Response((e as Error).message, { status })
  } finally {
    pushing.delete(repo)
  }
}
