// The markdown app's routes, under /app/markdown/. Opening, listing and
// closing files are host/files/routes.ts. Each open file's page lives at
// /app/markdown/<id>/, with its doc socket, helix pty socket, local media, and
// its thread's routes (host/chat/routes.ts). The client bundles, stylesheets,
// and GitHub embeds are shared by every file and sit at /app/markdown/
// itself: bundle.js for a file's page, and preview.js with just the
// <ah-markdown> element, for other pages that show a file.

import { createReadStream, statSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import type { WebSocket } from "ws"
import { assetPath } from "../../host/assets.ts"
import { ClientBundles } from "../../host/bundle.ts"
import { threadRoute } from "../../host/chat/routes.ts"
import { type FileInfo, OpenFiles } from "../../host/files/files.ts"
import { fileRoutes } from "../../host/files/routes.ts"
import { type LiveMarkdown, markdownFiles, type MarkdownFile } from "./files.ts"
import { fetchBlob, mimeTypes, resolveAsset } from "./github.ts"
import { indexPage, page } from "./page.ts"

const css = { "content-type": "text/css; charset=utf-8" }
const stylesheets = new Set(["markdown.css", "xterm.css"])

export class MarkdownApp {
  files: OpenFiles<LiveMarkdown>
  #bundles = new ClientBundles("markdown")

  /** `port` is the server's, for telling the agent which one to answer */
  constructor(port: number) {
    this.files = new OpenFiles(port, markdownFiles)
  }

  /** Open `path` for another app's page to show with <ah-markdown>, without
   * binding it to a session; null if it isn't a readable file */
  async show(path: string): Promise<FileInfo | null> {
    try {
      if (!statSync(path).isFile()) return null
      const file = await this.files.ensure(path)
      this.#bundles.prebuild("preview.js")
      return this.files.info(file)
    } catch {
      return null
    }
  }

  /** A file's doc socket, at <id>/doc, or its helix pane's, at <id>/pty */
  upgrade(rest: string, query: URLSearchParams): ((ws: WebSocket) => void) | null {
    const m = rest.match(/^([^/]+)\/(doc|pty)$/)
    const file = m && this.files.get(m[1])
    if (!file) return null
    if (m[2] === "pty") return (ws) => void file.live.helix.connect(ws, query)
    return (ws) =>
      file.pages.connect(ws, [file.live.doc.message(), file.thread.snapshot(true)])
  }

  /** `rest` is the path after /app/markdown/ */
  async handle(req: Request, rest: string): Promise<Response> {
    const { searchParams } = new URL(req.url)
    const fileResponse = await fileRoutes(req, rest, this.files, {
      opened: () => this.#bundles.prebuild("bundle.js"),
      page: (req, file, sub) => this.#page(req, file, sub),
    })
    if (fileResponse) return fileResponse

    if (rest === "") {
      const files = this.files.list().map((f) => ({
        id: f.id,
        name: escape(basename(f.path)),
      }))
      return new Response(indexPage(files), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    if (stylesheets.has(rest)) {
      const text = await readFile(assetPath(`app/markdown/${rest}`), "utf8")
      return new Response(text, { headers: css })
    }
    if (rest === "gh/blob") return await ghBlob(searchParams)
    if (rest === "gh/asset") {
      try {
        return Response.json(await resolveAsset(searchParams.get("url") ?? ""))
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
      }
    }

    return new Response("not found", { status: 404 })
  }

  /** `sub` is the path after the file's page, /app/markdown/<id>/ */
  async #page(req: Request, file: MarkdownFile, sub: string): Promise<Response> {
    const { searchParams } = new URL(req.url)
    if (sub === "") {
      const editor = searchParams.get("editor") !== "off"
      const chat = searchParams.get("chat") !== "off"
      return new Response(page(escape(basename(file.path)), { editor, chat }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    const threadResponse = await threadRoute(req, sub, file.thread)
    if (threadResponse) return threadResponse
    if (sub === "local") return await localMedia(file.path, searchParams.get("path") ?? "")
    return new Response("not found", { status: 404 })
  }
}

const escape = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  )

async function ghBlob(q: URLSearchParams): Promise<Response> {
  const args = ["owner", "repo", "ref", "path"].map((k) => q.get(k) ?? "")
  // Each becomes a cache path segment, so no traversal or separators
  const segment = /^(?!\.\.?$)[\w.-]+$/
  const valid =
    args.slice(0, 3).every((a) => segment.test(a)) &&
    args[3].split("/").every((a) => segment.test(a))
  if (!valid) return new Response("bad request", { status: 400 })
  try {
    const [owner, repo, ref, path] = args
    return new Response(await fetchBlob(owner, repo, ref, path), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
  }
}

/** Images and videos the file references by local path, relative to it */
async function localMedia(filePath: string, p: string): Promise<Response> {
  const resolved = p.startsWith("/") ? p : join(dirname(filePath), p)
  let real: string
  try {
    real = await realpath(resolved)
  } catch {
    return new Response("not found", { status: 404 })
  }
  // Anything under $HOME or next to the file; nothing else is a plausible
  // screenshot location.
  const allowed = [homedir(), dirname(filePath)]
  if (!allowed.some((dir) => real.startsWith(dir + "/"))) {
    return new Response("forbidden", { status: 403 })
  }
  const ext = real.split(".").pop()?.toLowerCase() ?? ""
  const body = Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>
  return new Response(body, {
    headers: { "content-type": mimeTypes[ext] ?? "application/octet-stream" },
  })
}
