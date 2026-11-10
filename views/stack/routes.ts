// A stack's page as a page app (views/page/app.ts): its PRs from jj and from
// GitHub, its diff buttons, which open skepsis, and its Body buttons, all
// under the page's _ah/; and a watch on its repo's operations, so the page
// reads its stack again after each one, and whenever stack.json or a PR's
// body is saved.

import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentId } from "../../model.ts"
import { rootFinder } from "../../core/workspace.ts"
import type { PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import { ensureBody, readStack, STACK_FILE, stackOpsDir } from "./data.ts"
import { readGithub } from "./github.ts"
import { diffArgs, openSkepsis } from "./skepsis.ts"

/** Open a markdown file in its doc page, bound to `agent` */
export type OpenDoc = (path: string, agent: AgentId | null) => Promise<void>

const json = (data: unknown) => Response.json(data, { headers: noStore })
const failed = (e: Error) => new Response(e.message, { status: 500 })
const done = () => new Response(null, { status: 204 })

/** `openDoc` opens a PR's body */
export function stackApp(openDoc: OpenDoc): PageApp {
  return {
    async routes(sub, req, path, agent) {
      if (sub === "_ah/stack") return await readStack(path).then(json, failed)
      if (sub === "_ah/stack-github") return await readGithub(path).then(json, failed)
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
      return null
    },
    async watch(path) {
      const dir = await stackOpsDir(path)
      const data = (filename: string) => filename === STACK_FILE || filename.endsWith(".md")
      return dir ? { dirs: [dir], data } : null
    },
  }
}
