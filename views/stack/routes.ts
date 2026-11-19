// A stack's page as a page app (views/page/app.ts): its PRs from jj, from
// GitHub, and from jj-spr, its diff buttons, which open skepsis, its Body
// buttons, its Push, Land, and Sync buttons (spr.ts), and the drafts of the
// push messages (message.ts), all under the page's _ah/; and a
// watch on its repo's operations, so the page reads its stack again after
// each one, and whenever the stack file or a PR's body is saved.

import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { type Confirm, confirmInWindow } from "../../platform/ask.ts"
import type { OpenFile, PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import { ensureBody, readStack, STACK_FILE, stackOpsDir } from "./data.ts"
import { type GhRun, ghRun, readGithub } from "./github.ts"
import { type AiRun, aiRun, draftMessage } from "./message.ts"
import { diffArgs, openSkepsis } from "./skepsis.ts"
import { readStatus, runSpr, type SprRun, sprRun } from "./spr.ts"

const json = (data: unknown) => Response.json(data, { headers: noStore })
const failed = (e: Error) => new Response(e.message, { status: 500 })
const done = () => new Response(null, { status: 204 })

/** `openDoc` opens a PR's body. `confirm`, `spr`, `gh` and `ai` are for
 * tests, which answer the sheet and stand in for jj-spr, gh and ai. */
export function stackApp(
  openDoc: OpenFile,
  confirm: Confirm = confirmInWindow,
  spr: SprRun = sprRun,
  gh: GhRun = ghRun,
  ai: AiRun = aiRun,
): PageApp {
  return {
    async routes(sub, req, path, agent) {
      if (sub === "_ah/stack") return await readStack(path).then(json, failed)
      if (sub === "_ah/stack-github") return await readGithub(path, gh).then(json, failed)
      if (sub === "_ah/stack-status") return await readStatus(path, spr).then(json, failed)
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
        const { tip }: { tip?: unknown } = await req.json().catch(() => ({}))
        const body = typeof tip === "string" ? await ensureBody(path, tip) : null
        if (!body) return new Response("not a PR in this stack", { status: 404 })
        return await openDoc(body, agent).then(done, failed)
      }
      if (sub === "_ah/spr" && req.method === "POST") {
        // The page's own URL, which its window was opened at
        const page = new URL("..", req.url)
        const body: unknown = await req.json().catch(() => null)
        return await runSpr(path, page, body, confirm, spr).catch(failed)
      }
      if (sub === "_ah/push-message" && req.method === "POST") {
        const { tip }: { tip?: unknown } = await req.json().catch(() => ({}))
        if (tip !== null && typeof tip !== "string")
          return new Response("bad tip", { status: 400 })
        const message = (m: string) => json({ message: m })
        return await draftMessage(path, tip, ai).then(message, failed)
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
