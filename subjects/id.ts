// Ids for files in a backend's page URLs, and for other things a URL names,
// like a diff to review: the id holds what it names and proves ah issued it,
// so the server serves a page for the URLs it gave out and nothing else, with
// no table to keep. Pages share an origin and can read any URL on it, so a
// page could otherwise reach any file by guessing its path.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, extname } from "node:path"
import { ahStateDir } from "../platform/paths.ts"

const keys = new Map<string, Buffer>()

/** The key ids are signed with: made once, readable only by the user.
 * Deleting it revokes every URL. */
function key(): Buffer {
  const file = ahStateDir("url-key")
  let k = keys.get(file)
  if (k) return k
  try {
    k = readFileSync(file)
  } catch {
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" })
    } catch {
      // Another process made it first
    }
    k = readFileSync(file)
  }
  keys.set(file, k)
  return k
}

/** 96 bits of the payload's HMAC */
const sign = (payload: string) =>
  createHmac("sha256", key()).update(payload).digest("base64url").slice(0, 16)

/** `<slug>~<payload, base64url>~<its signature>`. The slug keeps the URL bar
 * readable, and isn't signed, so what takes an id checks it. The same
 * payload always gets the same id, across restarts. `~` is in no part, so
 * `slug` mustn't have one. */
export const signedId = (slug: string, payload: string) =>
  `${slug}~${Buffer.from(payload).toString("base64url")}~${sign(payload)}`

/** The slug and payload of `id`, if ah issued it */
export function payloadOf(id: string): { slug: string; payload: string } | null {
  const parts = id.split("~")
  if (parts.length !== 3) return null
  const payload = Buffer.from(parts[1], "base64url").toString()
  const given = Buffer.from(parts[2])
  const expected = Buffer.from(sign(payload))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return signedId(parts[0], payload) === id ? { slug: parts[0], payload } : null
}

/** The id of the file at `path`: its name without its extension as the
 * slug, e.g. `notes~L3IvYS5tZA~…` */
export function fileId(path: string): string {
  const name = basename(path)
  const slug = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
  return signedId(slug, path)
}

/** The path `id` names, if ah issued it */
export function pathOf(id: string): string | null {
  const path = payloadOf(id)?.payload
  return path !== undefined && fileId(path) === id ? path : null
}
