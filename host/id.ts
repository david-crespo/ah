// Ids for files open in an app, used in its URLs

import { basename, extname } from "node:path"

/** `<file name without its extension>-<8 hex of the path's hash>`, e.g.
 * `notes-1a2b3c4d`. The name keeps the URL bar readable; the hash tells
 * same-named files apart, and keeps a path's id stable across restarts. */
export function fileId(path: string): string {
  const name = basename(path)
  const slug = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
  return `${slug}-${fnv1a(path).toString(16).padStart(8, "0")}`
}

// FNV-1a, 32 bits: plenty to tell apart the handful of files open at once,
// and sync, unlike crypto.subtle
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
