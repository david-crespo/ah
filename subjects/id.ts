// Ids for files in a backend's page URLs: the id names the file and proves ah
// issued it, so the server serves a page for the URLs it gave out and nothing
// else, with no table to keep. Pages share an origin and can read any URL on
// it, so a page could otherwise reach any file by guessing its path.

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

/** 96 bits of the path's HMAC */
const sign = (path: string) =>
  createHmac("sha256", key()).update(path).digest("base64url").slice(0, 16)

/** `<file name without its extension>~<the path, base64url>~<its signature>`,
 * e.g. `notes~L3IvYS5tZA~…`. The name keeps the URL bar readable; the same
 * path always gets the same id, across restarts. `~` is in neither part. */
export function fileId(path: string): string {
  const name = basename(path)
  const slug = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
  return `${slug}~${Buffer.from(path).toString("base64url")}~${sign(path)}`
}

/** The path `id` names, if ah issued it */
export function pathOf(id: string): string | null {
  const parts = id.split("~")
  if (parts.length !== 3) return null
  const path = Buffer.from(parts[1], "base64url").toString()
  const given = Buffer.from(parts[2])
  const expected = Buffer.from(sign(path))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return fileId(path) === id ? path : null
}
