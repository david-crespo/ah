// The routes every backend with open files has, under /view/<name>/. The CLI opens
// files through `files`, handing over the agent it runs in and where its
// session can be reached, since the server isn't the session's child; `files` also lists them,
// `files/<id>` closes one, and `files/handoff` gives `ah server restart` what it
// takes to open them all again in the next server. Each open file's page lives at <id>/, and the backend
// handles everything under it. File ids always end in -<hash>, so they can't
// collide with the backend's own routes.

import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { isRecord, isString } from "../../platform/guards.ts"
import { parseAddress, parseAgentRef } from "../../platform/session.ts"
import type { Address, AgentId, AgentRef } from "../../core/model.ts"
import type { Live, OpenFile, OpenFiles } from "./files.ts"

/** What the CLI sends to open a file: the agent it runs in (`agent`), or
 * the agent's id (`agentId`) for `ah server restart`'s handoff or one picked
 * from a shell's tab, and where that agent can be reached */
export interface OpenRequest {
  path: string
  address: Address | null
  agent?: AgentRef | null
  agentId?: AgentId | null
}

function parseOpenRequest(value: unknown): OpenRequest | null {
  if (!isRecord(value)) return null
  const { path } = value
  if (typeof path !== "string" || !isAbsolute(path)) return null
  const agent = value.agent == null ? null : parseAgentRef(value.agent)
  if (value.agent != null && !agent) return null
  const agentId = value.agentId == null ? null : value.agentId
  if (agentId !== null && !isString(agentId)) return null
  if (value.address === null) return { path, address: null, agent, agentId }
  const address = parseAddress(value.address)
  return address && { path, address, agent, agentId }
}

export interface FileRouteOptions<L extends Live> {
  /** After the CLI opens a file, e.g. to start building its page's bundle */
  opened?: () => void
  /** Everything under an open file's page; `sub` is the path after <id>/ */
  page: (req: Request, file: OpenFile<L>, sub: string) => Promise<Response>
}

/** `rest` is the path after /view/<name>/; null for anything that isn't the
 * files API or an open file's page */
export async function fileRoutes<L extends Live>(
  req: Request,
  rest: string,
  files: OpenFiles<L>,
  { opened, page }: FileRouteOptions<L>,
): Promise<Response | null> {
  if (rest === "files" && req.method === "POST") {
    const request = parseOpenRequest(await req.json().catch(() => null))
    if (!request) return new Response("invalid open request\n", { status: 400 })
    const { path, address, agent, agentId } = request
    try {
      if (!(await stat(path)).isFile()) return new Response("not a file\n", { status: 400 })
    } catch {
      return new Response(`no such file: ${path}\n`, { status: 404 })
    }
    const file = await files.open(
      path,
      address,
      agentId ?? (agent && files.agentId(agent)) ?? null,
    )
    opened?.()
    return Response.json(files.info(file))
  }
  if (rest === "files" && req.method === "GET") {
    return Response.json(files.list().map((f) => files.info(f)))
  }
  if (rest === "files/handoff" && req.method === "GET") {
    return Response.json(
      files.list().map((f): OpenRequest => ({
        path: f.path,
        address: files.address(f.binding),
        agentId: f.binding.agent,
      })),
    )
  }
  const closing = rest.match(/^files\/([^/]+)$/)
  if (closing && req.method === "DELETE") {
    const file = files.close(closing[1])
    if (!file) return new Response("not open\n", { status: 404 })
    return Response.json(files.info(file))
  }

  const m = rest.match(/^([^/]+)(\/?)(.*)$/)
  const file = m && files.get(m[1])
  if (!m || !file) return null
  const [, , slash, sub] = m
  // The page's URLs are relative to its directory
  if (!slash) return Response.redirect(new URL(files.info(file).url, req.url), 302)
  return await page(req, file, sub)
}
