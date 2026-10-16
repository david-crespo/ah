// GitHub embeds for the preview: permalink snippets
// and user-attachments assets, which the page renders the way GitHub does.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cacheHome } from "../../platform/paths.ts"
import { run } from "../../platform/proc.ts"

let ghTokenPromise: Promise<string | null> | undefined
function ghToken(): Promise<string | null> {
  ghTokenPromise ??= run("gh", ["auth", "token"])
    .then((o) => (o.success ? o.stdout.trim() || null : null))
    .catch(() => null)
  return ghTokenPromise
}

async function ghHeaders(): Promise<HeadersInit> {
  const token = await ghToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

const cacheDir = join(cacheHome(), "ah", "markdown")

// File contents at a ref. A full commit sha is immutable, so those are cached
// on disk forever; branch names and short shas are fetched every time.
export async function fetchBlob(owner: string, repo: string, ref: string, path: string) {
  const immutable = /^[0-9a-f]{40}$/.test(ref)
  const cachePath = join(cacheDir, "blobs", owner, repo, ref, path)
  if (immutable) {
    try {
      return await readFile(cachePath, "utf8")
    } catch {
      // not cached
    }
  }
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
  const res = await fetch(url, { headers: await ghHeaders() })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  const text = await res.text()
  if (immutable) {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, text)
  }
  return text
}

// github.com/user-attachments/assets/<id> redirects to a signed S3 URL that
// works for a few minutes. Resolve it server-side and hand the browser that
// URL, so the bytes never pass through here. Redirects are followed only
// within the allowlisted hosts; the final S3
// hostname varies, so the type comes from the redirect URL rather than a
// response header. No auth: public-repo assets need none, and private ones
// are gated on a browser session (a JWT-signed private-user-images URL)
// that a token can't replace.
const assetHosts = ["github.com", "private-user-images.githubusercontent.com"]
export async function resolveAsset(url: string) {
  for (let hops = 0; hops < 5; hops++) {
    const u = new URL(url)
    if (!assetHosts.includes(u.hostname)) {
      const type =
        u.searchParams.get("response-content-type") ??
        mimeTypes[u.pathname.split(".").pop()?.toLowerCase() ?? ""] ??
        ""
      return { src: url, type }
    }
    const res = await fetch(url, { redirect: "manual" })
    await res.body?.cancel()
    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href
      continue
    }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
    throw new Error(`asset not accessible: ${url}`)
  }
  throw new Error(`too many redirects: ${url}`)
}

export const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
}
