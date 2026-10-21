// The routes every backend for files has, under /view/<name>/. The CLI shows
// files through `files`, handing over the agent it runs in and where its
// session can be reached, since the server isn't the session's child; `files`
// also lists what pages show, `files?path=` closes a file's windows, and
// `files/thread?path=` is any file's thread, for the agent's replies (`ah
// request respond`) and what's pending. A file's page lives at <id>/, the
// signed id that names its path (subjects/id.ts), and the backend handles
// everything under it. Ids always have a `~`, so they can't collide with the
// backend's own routes.

import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { isRecord, isString } from "../../platform/guards.ts"
import { parseAddress, parseAgentRef } from "../../platform/session.ts"
import type { Address, AgentId, AgentRef } from "../../core/model.ts"
import { pathOf } from "../id.ts"
import { threadRoute } from "../thread/routes.ts"
import type { Files, Live } from "./files.ts"

/** What the CLI sends to show a file: the agent it runs in (`agent`), or
 * the agent's id (`agentId`) for one picked from a shell's tab, and where
 * that agent can be reached */
export interface ShowRequest {
  path: string
  address: Address | null
  agent?: AgentRef | null
  agentId?: AgentId | null
}

function parseShowRequest(value: unknown): ShowRequest | null {
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

export interface FileRouteOptions {
  /** After the CLI shows a file, e.g. to start building its page's bundle */
  shown?: () => void
  /** Everything under a file's page; `sub` is the path after <id>/ */
  page: (req: Request, path: string, id: string, sub: string) => Promise<Response>
}

/** A file to serve: an absolute path to one that's there */
async function fileAt(path: string | null): Promise<Response | null> {
  if (!path || !isAbsolute(path))
    return new Response("path must be absolute\n", { status: 400 })
  try {
    if (!(await stat(path)).isFile()) return new Response("not a file\n", { status: 400 })
  } catch {
    return new Response(`no such file: ${path}\n`, { status: 404 })
  }
  return null
}

/** `rest` is the path after /view/<name>/; null for anything that isn't the
 * files API or a file's page */
export async function fileRoutes<L extends Live>(
  req: Request,
  rest: string,
  files: Files<L>,
  { shown, page }: FileRouteOptions,
): Promise<Response | null> {
  const query = new URL(req.url).searchParams
  if (rest === "files" && req.method === "POST") {
    const request = parseShowRequest(await req.json().catch(() => null))
    if (!request) return new Response("invalid show request\n", { status: 400 })
    const { path, address, agent, agentId } = request
    const bad = await fileAt(path)
    if (bad) return bad
    const info = await files.bind(
      path,
      address,
      agentId ?? (agent && files.agentId(agent)) ?? null,
    )
    shown?.()
    return Response.json(info)
  }
  if (rest === "files" && req.method === "GET") {
    return Response.json(files.shown().map((path) => files.info(path)))
  }
  if (rest === "files" && req.method === "DELETE") {
    const path = query.get("path") ?? ""
    const closed = files.close(path)
    if (!closed) return new Response("no window shows it\n", { status: 404 })
    return Response.json({ ...files.info(path), closed })
  }
  if (rest === "files/thread") {
    const path = query.get("path")
    const bad = await fileAt(path)
    if (bad) return bad
    const response = await threadRoute(req, "activity", await files.thread(path!))
    return response ?? new Response("not found\n", { status: 404 })
  }

  const m = rest.match(/^([^/]*~[^/]*)(\/?)(.*)$/)
  const path = m && pathOf(m[1])
  if (!m || !path) return null
  const [, id, slash, sub] = m
  // Gone since the URL was given out
  if (await fileAt(path)) return new Response("no such file\n", { status: 404 })
  // The page's URLs are relative to its directory
  if (!slash) return Response.redirect(new URL(files.info(path).url, req.url), 302)
  return await page(req, path, id, sub)
}
