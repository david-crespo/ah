// A page's request to open a diff in skepsis (routes.ts), at its
// _ah/skepsis, in a jj workspace the page may open things in
// (views/workspaces/app.ts). Comments go to the agent the page is bound to.

import { isRecord } from "../../platform/guards.ts"
import type { PageApp } from "../page/app.ts"
import { inWorkspace } from "../workspaces/app.ts"

/** A diff a page asks for: one revision, or a range, and with `interdiff`,
 * how `to` changed `from`'s changes (jj interdiff) */
export type DiffRequest = { rev: string } | { from: string; to: string; interdiff: boolean }

/** A diff to review in `cwd`, the root of a jj workspace; comments go to
 * the agent the page at `page` is bound to */
export interface DiffSpec {
  cwd: string
  diff: DiffRequest
  page: string
}

export type OpenDiff = (spec: DiffSpec) => Promise<void>

/** The diff in a page's request, or null for anything else, or a revision
 * starting with "-", which jj would take for a flag */
export function diffArgs(body: unknown): DiffRequest | null {
  const rev = (v: unknown): v is string =>
    typeof v === "string" && /^[^-\s][^\s]{0,499}$/.test(v)
  if (!isRecord(body)) return null
  if (rev(body.rev)) return { rev: body.rev }
  if (rev(body.from) && rev(body.to))
    return { from: body.from, to: body.to, interdiff: body.interdiff === true }
  return null
}

/** `openDiff` opens the diff a page's request names, in `cwd` if it gives
 * one, else in the page's own workspace */
export function diffApp(openDiff: OpenDiff): PageApp {
  return {
    async routes(sub, req, path) {
      if (sub !== "_ah/skepsis" || req.method !== "POST") return null
      const body: unknown = await req.json().catch(() => null)
      return await inWorkspace(path, body, async (cwd) => {
        const diff = diffArgs(body)
        if (!diff) return new Response("bad diff", { status: 400 })
        await openDiff({ cwd, diff, page: path })
        return new Response(null, { status: 204 })
      })
    },
  }
}
