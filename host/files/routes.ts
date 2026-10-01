// The routes every app with open files has, under /app/<name>/. The CLI opens
// files through `files`, handing over the session's inbox socket and token
// since the server isn't the session's child; `files` also lists them, and
// `files/<id>` closes one. Each open file's page lives at <id>/, and the app
// handles everything under it. File ids always end in -<hash>, so they can't
// collide with the app's own routes.

import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { isRecord } from "../guards.ts"
import { parseSession, type Session } from "../session.ts"
import type { Live, OpenFile, OpenFiles } from "./files.ts"

/** What the CLI sends to open a file */
export interface OpenRequest {
  path: string
  session: Session | null
}

function parseOpenRequest(value: unknown): OpenRequest | null {
  if (!isRecord(value)) return null
  const { path } = value
  if (typeof path !== "string" || !isAbsolute(path)) return null
  if (value.session === null) return { path, session: null }
  const session = parseSession(value.session)
  return session && { path, session }
}

export interface FileRouteOptions<L extends Live> {
  /** After the CLI opens a file, e.g. to start building its page's bundle */
  opened?: () => void
  /** Everything under an open file's page; `sub` is the path after <id>/ */
  page: (req: Request, file: OpenFile<L>, sub: string) => Promise<Response>
}

/** `rest` is the path after /app/<name>/; null for anything that isn't the
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
    const { path, session } = request
    try {
      if (!(await stat(path)).isFile()) return new Response("not a file\n", { status: 400 })
    } catch {
      return new Response(`no such file: ${path}\n`, { status: 404 })
    }
    const file = await files.open(path, session)
    opened?.()
    return Response.json(files.info(file))
  }
  if (rest === "files" && req.method === "GET") {
    return Response.json(files.list().map((f) => files.info(f)))
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
