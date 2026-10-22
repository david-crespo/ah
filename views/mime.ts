import { extname } from "node:path"

/** Content types of what pages serve from disk, by extension, lowercase with
 * its dot as `extname` gives it */
export const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
}

/** The type of an image or video at this path, or undefined for anything
 * else: all a markdown page shows from a local path or a GitHub asset */
export function mediaType(path: string): string | undefined {
  const type = contentTypes[extname(path).toLowerCase()]
  return type?.startsWith("image/") || type?.startsWith("video/") ? type : undefined
}
