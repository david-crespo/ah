// The html app's routes, under /app/html/, on two ports. An agent's HTML can
// run any script, a CDN's included, so its pages get a port of their own (the
// server's port + 1): a separate origin, which the API port refuses
// (host/origin.ts), so a page can't read files, list sessions, or post into
// them through the API.
//
// The API port has what the CLI uses: opening, listing and closing files
// (host/files/routes.ts), and <id>/_ah/activity, where the agent answers. A
// page's URL there redirects to the pages port.
//
// The pages port has a file's page, /app/html/<id>/: the file as is, with the
// thread's stylesheet, popover and client script added before </body>.
// Everything else under <id>/ is the files next to it, so the page's relative
// links work, except <id>/_ah/, which is ah's: the socket (reloads and the
// conversation) and the comment route. chat.js, the client, is shared by
// every page. All pages share the one origin, so one page could post a
// comment into another's thread; the agent's own activity stays on the API
// port.

import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { Readable } from "node:stream"
import type { WebSocket } from "ws"
import { ClientBundles } from "../../host/bundle.ts"
import { chatStylesheet, selectionPopover } from "../../host/chat/page.ts"
import { threadRoute } from "../../host/chat/routes.ts"
import { type AgentDirectory, type FileInfo, OpenFiles } from "../../host/files/files.ts"
import { fileRoutes } from "../../host/files/routes.ts"
import { type HtmlFile, htmlFiles, type LiveReload } from "./files.ts"

const types: Record<string, string> = {
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
  ".webm": "video/webm",
}

// Pages reload on every change, so nothing they load should be cached
const noStore = { "cache-control": "no-store" }

// For the dashboard's frames: dark over the page's own color-scheme, which
// may leave it to the browser's, since the dashboard is dark whatever that
// is; and see-through, so the page sits on the dashboard's background
const dashboardStyle =
  "<style>:root { color-scheme: dark !important; } html, body { background: transparent !important; }</style>"

/** The file with ah's tags before </body>, or at the end without one.
 * `dashboard` is for the dashboard's frames of it. */
export function inject(
  html: string,
  id: string,
  { chat, dashboard = false }: { chat: boolean; dashboard?: boolean },
): string {
  const script = `<script type="module" src="/app/html/chat.js" data-ah-thread="/app/html/${id}/_ah/"${chat ? "" : ' data-ah-chat="off"'}></script>`
  const tags = [
    ...(dashboard ? [dashboardStyle] : []),
    ...(chat ? [chatStylesheet, selectionPopover] : []),
    script,
  ].join("\n")
  const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i)
  return end < 0 ? html + "\n" + tags : html.slice(0, end) + tags + "\n" + html.slice(end)
}

export class HtmlApp {
  files: OpenFiles<LiveReload>
  #bundles = new ClientBundles("html")
  /** Where the pages are */
  readonly pagesOrigin: string

  /** `port` is the server's, for telling the agent which one to answer,
   * `pagesPort` the one pages are served on, and `directory` where the
   * agents its files are bound to are now */
  constructor(port: number, pagesPort: number, directory: AgentDirectory | null = null) {
    this.pagesOrigin = `http://127.0.0.1:${pagesPort}`
    this.files = new OpenFiles(port, htmlFiles, { pageOrigin: this.pagesOrigin, directory })
  }

  /** Open `path` for the dashboard to show in a frame, leaving any binding
   * alone; null if it isn't a readable file */
  async show(path: string): Promise<FileInfo | null> {
    try {
      if (!(await stat(path)).isFile()) return null
      const file = await this.files.ensure(path)
      this.#bundles.prebuild("chat.js")
      return this.files.info(file)
    } catch {
      return null
    }
  }

  /** On the API port; `rest` is the path after /app/html/ */
  async handle(req: Request, rest: string): Promise<Response> {
    const fileResponse = await fileRoutes(req, rest, this.files, {
      opened: () => this.#bundles.prebuild("chat.js"),
      page: async (req, file, sub) => {
        if (sub === "_ah/activity") {
          return (await threadRoute(req, "activity", file.thread)) ?? notFound()
        }
        if (req.method !== "GET") return notFound()
        const { search } = new URL(req.url)
        const url = new URL(`/app/html/${file.id}/${sub}${search}`, this.pagesOrigin)
        return Response.redirect(url, 302)
      },
    })
    if (fileResponse) return fileResponse
    if (rest === "") return indexPage(this.files.list())
    return notFound()
  }

  /** On the pages port; `rest` is the path after /app/html/ */
  async handlePage(req: Request, rest: string): Promise<Response> {
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    const m = rest.match(/^([^/]+)(\/?)(.*)$/)
    const file = m && this.files.get(m[1])
    if (!m || !file) return notFound()
    const [, , slash, sub] = m
    // The page's URLs are relative to its directory
    if (!slash) return Response.redirect(new URL(`/app/html/${file.id}/`, req.url), 302)
    // The agent's, on the API port
    if (sub === "_ah/activity") return notFound()
    return await this.#page(req, file, sub)
  }

  /** A page's socket, at <id>/_ah/socket on the pages port */
  upgradePage(rest: string): ((ws: WebSocket) => void) | null {
    const m = rest.match(/^([^/]+)\/_ah\/socket$/)
    const file = m && this.files.get(m[1])
    if (!file) return null
    return (ws) => file.pages.connect(ws, [file.thread.snapshot(true)])
  }

  /** `sub` is the path after the file's page, /app/html/<id>/ */
  async #page(req: Request, file: HtmlFile, sub: string): Promise<Response> {
    if (sub.startsWith("_ah/")) {
      return (await threadRoute(req, sub.slice("_ah/".length), file.thread)) ?? notFound()
    }
    if (sub === "") {
      const query = new URL(req.url).searchParams
      const chat = query.get("chat") !== "off"
      const dashboard = query.get("in") === "dashboard"
      let html: string
      try {
        html = await readFile(file.path, "utf8")
      } catch {
        return new Response(`can't read ${file.path}`, { status: 404 })
      }
      return new Response(inject(html, file.id, { chat, dashboard }), {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      })
    }
    return await sibling(file.path, sub)
  }
}

const notFound = () => new Response("not found", { status: 404 })

/** A file next to the page, or under its directory */
async function sibling(pagePath: string, sub: string): Promise<Response> {
  const dir = dirname(pagePath)
  let real: string
  try {
    real = await realpath(join(dir, decodeURIComponent(sub)))
    if (!real.startsWith((await realpath(dir)) + "/")) {
      return new Response("forbidden", { status: 403 })
    }
    if (!(await stat(real)).isFile()) return new Response("not found", { status: 404 })
  } catch {
    return new Response("not found", { status: 404 })
  }
  const body = Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>
  const type = types[extname(real).toLowerCase()] ?? "application/octet-stream"
  return new Response(body, { headers: { "content-type": type, ...noStore } })
}

function indexPage(pages: HtmlFile[]): Response {
  const escape = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
    )
  const rows = pages.map(
    (p) =>
      `<li><a href="${p.id}/">${escape(basename(p.path))}</a> <code>${escape(p.path)}</code></li>`,
  )
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Open pages</title>
<style>
  body { margin: 24px; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color-scheme: light dark; }
  code { color: GrayText; }
</style>
</head>
<body>
${rows.length ? `<ul>${rows.join("")}</ul>` : "<p>No pages open.</p>"}
</body>
</html>`
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
}
