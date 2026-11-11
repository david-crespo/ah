// Fetching a stack page's repo from its page, served at the page's _ah/fetch:
// `jj git fetch` at the repo's root, for when GitHub has a PR's branch at a
// commit the last fetch didn't bring. A fetch sends nothing and only moves
// remote bookmarks, so unlike a push it needs no sheet to confirm it. One
// fetch at a time per repo, and it's the first one asked for: nothing before
// the lock awaits, so a later request can't take it first.

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { type JjRun, repoDir } from "../../platform/jj.ts"
import { STACK_FILE } from "./data.ts"

/** Repos with a fetch running, by repo dir */
const fetching = new Set<string>()

/** `{ output }` from `jj git fetch` in the repo of the stack page at
 * `pagePath`, or jj's complaint with a 500 */
export async function fetchRepo(pagePath: string, jjRun: JjRun): Promise<Response> {
  const dir = dirname(pagePath)
  // Only a stack's page fetches
  if (!existsSync(join(dir, STACK_FILE)))
    return new Response("not a stack's page", { status: 404 })
  const root = rootFinder()(dir)
  if (!root) return new Response(`${dir} isn't in a jj workspace`, { status: 500 })
  const repo = repoDir(root)
  if (fetching.has(repo))
    return new Response("a fetch is already running in this repo", { status: 409 })
  fetching.add(repo)
  try {
    const out = await jjRun(root, "git", "fetch")
    if (!out.success) return new Response(out.stderr.trim(), { status: 500 })
    return Response.json({ output: (out.stderr + out.stdout).trim() || "Nothing changed." })
  } finally {
    fetching.delete(repo)
  }
}
