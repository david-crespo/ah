// A stack page's diff buttons (client.ts) open the diff in skepsis, a diff
// review whose comments go to the agent the page is bound to. The server
// hosts skepsis itself (views/skepsis/); this is what a page may ask it for.

import { isRecord } from "../../platform/guards.ts"

/** A diff a page asks for: one revision, or a range, and with `interdiff`,
 * how `to` changed `from`'s changes (jj interdiff) */
export type DiffRequest = { rev: string } | { from: string; to: string; interdiff: boolean }

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
