// The markdown backend's routes, under /view/markdown/. Showing, listing and
// closing files are subjects/files/routes.ts. Each file's page lives at
// /view/markdown/<id>/, with its doc socket, editor pane's socket, local media, and
// the route its requests go to (subjects/thread/routes.ts). The client bundles, stylesheets,
// and GitHub embeds are shared by every file and sit at /view/markdown/
// itself: bundle.js for a file's page, and preview.js with just the
// <ah-markdown> element, for other pages that show a file.

import { createReadStream } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import type { WebSocket } from "ws"
import { assetPath } from "../../platform/assets.ts"
import { ClientBundles } from "../../platform/bundle.ts"
import { plainlyUnder } from "../../platform/paths.ts"
import { threadRoute } from "../../subjects/thread/routes.ts"
import {
  type AgentDirectory,
  type FileInfo,
  Files,
  locationOf,
} from "../../subjects/files/files.ts"
import { fileRoutes } from "../../subjects/files/routes.ts"
import { pathOf } from "../../subjects/id.ts"
import { type LiveMarkdown, markdownFiles } from "./files.ts"
import { fetchBlob, resolveAsset } from "./github.ts"
import { indexPage, page } from "./page.ts"
import { escapeHtml } from "../escape.ts"
import { mediaType } from "../mime.ts"

const css = { "content-type": "text/css; charset=utf-8" }
const stylesheets = new Set(["markdown.css", "xterm.css"])

export class MarkdownBackend {
  files: Files<LiveMarkdown>
  #bundles = new ClientBundles("markdown")

  /** `port` is the server's, for telling the agent which one to answer, and
   * `directory` where the agents its files are bound to are now */
  constructor(port: number, directory: AgentDirectory) {
    this.files = new Files(port, markdownFiles, directory)
  }

  /** `path` for another view's page to show with <ah-markdown>, without
   * binding it to a session; null if it isn't a readable file */
  show(path: string): Promise<FileInfo | null> {
    this.#bundles.prebuild("preview.js")
    return this.files.show(path)
  }

  /** A file's doc socket, at <id>/doc, or its editor pane's, at <id>/editor */
  upgrade(rest: string, query: URLSearchParams): ((ws: WebSocket) => void) | null {
    const m = rest.match(/^([^/]+)\/(doc|editor)$/)
    const path = m && pathOf(m[1])
    if (!m || !path) return null
    if (m[2] === "editor") {
      return (ws) =>
        void this.files.live(path).then(
          (live) => live.editor.connect(ws, query),
          () => ws.close(1011, "couldn't show the file"),
        )
    }
    return (ws) =>
      void this.files.connect(path, ws, locationOf(query), (live, thread) => [
        live.doc.message(),
        thread.snapshot(true),
      ])
  }

  /** `rest` is the path after /view/markdown/ */
  async handle(req: Request, rest: string): Promise<Response> {
    const { searchParams } = new URL(req.url)
    const fileResponse = await fileRoutes(req, rest, this.files, {
      shown: () => this.#bundles.prebuild("bundle.js"),
      page: (req, path, _id, sub) => this.#page(req, path, sub),
    })
    if (fileResponse) return fileResponse

    if (rest === "") {
      const files = this.files.shown().map((path) => ({
        id: this.files.info(path).id,
        name: escapeHtml(basename(path)),
      }))
      return new Response(indexPage(files), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    if (stylesheets.has(rest)) {
      const text = await readFile(assetPath(`views/markdown/${rest}`), "utf8")
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

  /** `sub` is the path after the file's page, /view/markdown/<id>/ */
  async #page(req: Request, path: string, sub: string): Promise<Response> {
    const { searchParams } = new URL(req.url)
    if (sub === "") {
      const editor = searchParams.get("editor") !== "off"
      const chat = searchParams.get("chat") !== "off"
      return new Response(
        page(escapeHtml(basename(path)), { editor, chat, path: escapeHtml(path) }),
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )
    }
    if (sub === "request") {
      return (
        (await threadRoute(req, sub, await this.files.thread(path))) ??
        new Response("not found", { status: 404 })
      )
    }
    if (sub === "local") return await localMedia(path, searchParams.get("path") ?? "")
    return new Response("not found", { status: 404 })
  }
}

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

/** Images and videos the file references by local path, relative to it:
 * under $HOME or next to the file, and outside dot directories */
export async function localMedia(filePath: string, p: string): Promise<Response> {
  const resolved = p.startsWith("/") ? p : join(dirname(filePath), p)
  const notFound = new Response("not found", { status: 404 })
  let real: string
  let allowed: string[]
  try {
    real = await realpath(resolved)
    allowed = await Promise.all([homedir(), dirname(filePath)].map((d) => realpath(d)))
  } catch {
    return notFound
  }
  // Nothing else is a plausible screenshot location
  if (!allowed.some((dir) => plainlyUnder(dir, real))) return notFound
  const type = mediaType(real)
  if (!type) return notFound
  const body = Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>
  return new Response(body, { headers: { "content-type": type } })
}
