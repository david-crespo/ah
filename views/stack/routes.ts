// A stack's page as a page app (views/page/app.ts): its PRs from jj, from
// GitHub, and from jjack, its Body buttons, its Push, Land, and Sync buttons
// (jjack.ts), and the drafts of the push messages (message.ts), all under the
// page's _ah/. And a watch on its repo's operations, so the page reads its
// stack again after each one, and whenever the stack file or a PR's body is
// saved. Its diff buttons open skepsis through views/skepsis/app.ts.

import { type Confirm, confirmInWindow } from "../../platform/ask.ts"
import type { OpenFile, PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import { ensureBody, readStack, STACK_FILE, stackOpsDir } from "./data.ts"
import { type GhRun, ghRun, readGithub } from "./github.ts"
import { type AiRun, aiRun, draftMessage } from "./message.ts"
import { type Jjack, jjackLibrary, readStatus, runJjack } from "./jjack.ts"

const json = (data: unknown) => Response.json(data, { headers: noStore })
const failed = (e: Error) => new Response(e.message, { status: 500 })
const done = () => new Response(null, { status: 204 })

/** `openDoc` opens a PR's body. `confirm`, `jjack`, `gh`, and `ai` are for
 * tests, which answer the sheet and stand in for jjack, gh, and ai. */
export function stackApp(
  openDoc: OpenFile,
  confirm: Confirm = confirmInWindow,
  jjack: Jjack = jjackLibrary,
  gh: GhRun = ghRun,
  ai: AiRun = aiRun,
): PageApp {
  return {
    async routes(sub, req, path, agent) {
      if (sub === "_ah/stack") return await readStack(path).then(json, failed)
      if (sub === "_ah/stack-github") return await readGithub(path, gh).then(json, failed)
      if (sub === "_ah/stack-status")
        return await readStatus(path, jjack).then(json, failed)
      if (sub === "_ah/pr-body" && req.method === "POST") {
        const { tip }: { tip?: unknown } = await req.json().catch(() => ({}))
        const body = typeof tip === "string" ? await ensureBody(path, tip) : null
        if (!body) return new Response("not a PR in this stack", { status: 404 })
        return await openDoc(body, agent).then(done, failed)
      }
      if (sub === "_ah/jjack" && req.method === "POST") {
        // The page's own URL, which its window was opened at
        const page = new URL("..", req.url)
        const body: unknown = await req.json().catch(() => null)
        return await runJjack(path, page, body, confirm, jjack).catch(failed)
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
