// A stack's page as a page app (views/page/app.ts): its PRs from jj and from
// GitHub, its diff buttons, which open skepsis, its Body buttons, its Push
// buttons (push.ts) and its Fetch buttons (fetch.ts), all under the page's _ah/; and a watch on its repo's operations, so the page
// reads its stack again after each one, and whenever stack.json or a PR's
// body is saved.

import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { type Confirm, confirmInWindow } from "../../platform/ask.ts"
import { type JjRun, jjRun } from "../../platform/jj.ts"
import type { OpenFile, PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import { ensureBody, readStack, STACK_FILE, stackOpsDir } from "./data.ts"
import { fetchRepo } from "./fetch.ts"
import { type GhRun, ghRun, readGithub } from "./github.ts"
import { push } from "./push.ts"
import { diffArgs, openSkepsis } from "./skepsis.ts"

const json = (data: unknown) => Response.json(data, { headers: noStore })
const failed = (e: Error) => new Response(e.message, { status: 500 })
const done = () => new Response(null, { status: 204 })

/** `openDoc` opens a PR's body. `confirm`, `run` and `gh` are for tests,
 * which answer the push's sheet and stand in for jj and gh. */
export function stackApp(
  openDoc: OpenFile,
  confirm: Confirm = confirmInWindow,
  run: JjRun = jjRun,
  gh: GhRun = ghRun,
): PageApp {
  return {
    async routes(sub, req, path, agent) {
      if (sub === "_ah/stack") return await readStack(path).then(json, failed)
      if (sub === "_ah/stack-github") return await readGithub(path, gh).then(json, failed)
      if (sub === "_ah/skepsis" && req.method === "POST") {
        // Only a stack's page starts processes
        if (!(await stat(join(dirname(path), STACK_FILE)).catch(() => null))) return null
        const diff = diffArgs(await req.json().catch(() => null))
        if (!diff) return new Response("bad diff", { status: 400 })
        // At the root, since jj reads skepsis's paths relative to where it runs
        const cwd = rootFinder()(dirname(path)) ?? dirname(path)
        return await openSkepsis(cwd, diff, agent).then(done, failed)
      }
      if (sub === "_ah/pr-body" && req.method === "POST") {
        const { bookmark }: { bookmark?: unknown } = await req.json().catch(() => ({}))
        const body = typeof bookmark === "string" ? await ensureBody(path, bookmark) : null
        if (!body) return new Response("not a PR in this stack", { status: 404 })
        return await openDoc(body, agent).then(done, failed)
      }
      if (sub === "_ah/push" && req.method === "POST") {
        const { bookmark }: { bookmark?: unknown } = await req.json().catch(() => ({}))
        // The page's own URL, which its window was opened at
        const page = new URL("..", req.url)
        return await push(path, page, bookmark, confirm, run, gh).catch(failed)
      }
      if (sub === "_ah/fetch" && req.method === "POST")
        return await fetchRepo(path, run).catch(failed)
      return null
    },
    async watch(path) {
      const dir = await stackOpsDir(path)
      const data = (filename: string) => filename === STACK_FILE || filename.endsWith(".md")
      return dir ? { dirs: [dir], data } : null
    },
  }
}
