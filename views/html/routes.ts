// The html backend's routes, under /view/html/, on two ports. An agent's HTML can
// run any script, a CDN's included, so its pages get a port of their own (the
// server's port + 1): a separate origin, which the API port refuses
// (platform/origin.ts), so a page can't read files, list sessions, or post into
// them through the API.
//
// The API port has what the CLI uses: showing, listing and closing files, and
// each file's thread, where the agent answers (subjects/files/routes.ts). A
// page's URL there redirects to the pages port.
//
// The pages port has a file's page, /view/html/<id>/: the file as is, with the
// thread's stylesheet, popover and client script added before </body>, and
// for a tracker, its status.
// Everything else under <id>/ is the files next to it, so the page's relative
// links work, except <id>/_ah/, which is ah's: the socket (reloads and the
// conversation) and the request route. chat.js, the client, is shared by
// every page. All pages share the one origin, so one page could post a
// request into another's thread; the agent's own activity is only on the API
// port.

import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { Readable } from "node:stream"
import type { WebSocket } from "ws"
import type { TrackerStatus } from "../../core/model.ts"
import type { Trackers } from "../../core/trackers.ts"
import { ClientBundles } from "../../platform/bundle.ts"
import { plainlyUnder } from "../../platform/paths.ts"
import { chatStylesheet, selectionPopover } from "../thread/page.ts"
import { threadRoute } from "../../subjects/thread/routes.ts"
import {
  type AgentDirectory,
  type FileInfo,
  Files,
  locationOf,
} from "../../subjects/files/files.ts"
import { fileRoutes } from "../../subjects/files/routes.ts"
import { pathOf } from "../../subjects/id.ts"
import { htmlFiles, type LiveReload } from "./files.ts"

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
 * `dashboard` is for the dashboard's frames of it, `status` the file's as a
 * tracker, if it is one. */
export function inject(
  html: string,
  id: string,
  {
    chat,
    dashboard = false,
    status = null,
  }: { chat: boolean; dashboard?: boolean; status?: TrackerStatus | null },
): string {
  const script = `<script type="module" src="/view/html/chat.js" data-ah-thread="/view/html/${id}/_ah/"${chat ? "" : ' data-ah-chat="off"'}></script>`
  const tags = [
    ...(status ? [`<meta name="ah-status" content="${status}">`] : []),
    ...(dashboard ? [dashboardStyle] : []),
    ...(chat ? [chatStylesheet, selectionPopover] : []),
    script,
  ].join("\n")
  const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i)
  return end < 0 ? html + "\n" + tags : html.slice(0, end) + tags + "\n" + html.slice(end)
}

export class HtmlBackend {
  files: Files<LiveReload>
  #bundles = new ClientBundles("html")
  /** Where the pages are */
  readonly pagesOrigin: string

  #trackers: Pick<Trackers, "setStatus" | "statusOf"> | null

  /** `port` is the server's, for telling the agent which one to answer,
   * `pagesPort` the one pages are served on, `directory` where the agents
   * its files are bound to are now, and `trackers` what a task list's Park,
   * Done, and Resume buttons go to */
  constructor(
    port: number,
    pagesPort: number,
    directory: AgentDirectory,
    trackers: Pick<Trackers, "setStatus" | "statusOf"> | null = null,
  ) {
    this.#trackers = trackers
    this.pagesOrigin = `http://127.0.0.1:${pagesPort}`
    this.files = new Files(port, htmlFiles, directory, { pageOrigin: this.pagesOrigin })
  }

  /** `path` for the dashboard to show in a frame, leaving any binding
   * alone; null if it isn't a readable file */
  show(path: string): Promise<FileInfo | null> {
    this.#bundles.prebuild("chat.js")
    return this.files.show(path)
  }

  /** On the API port; `rest` is the path after /view/html/ */
  async handle(req: Request, rest: string): Promise<Response> {
    const fileResponse = await fileRoutes(req, rest, this.files, {
      shown: () => this.#bundles.prebuild("chat.js"),
      page: async (req, _path, id, sub) => {
        if (req.method !== "GET") return notFound()
        const { search } = new URL(req.url)
        const url = new URL(`/view/html/${id}/${sub}${search}`, this.pagesOrigin)
        return Response.redirect(url, 302)
      },
    })
    if (fileResponse) return fileResponse
    if (rest === "")
      return indexPage(this.files.shown().map((path) => this.files.info(path)))
    return notFound()
  }

  /** On the pages port; `rest` is the path after /view/html/ */
  async handlePage(req: Request, rest: string): Promise<Response> {
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    const m = rest.match(/^([^/]+)(\/?)(.*)$/)
    const path = m && pathOf(m[1])
    if (!m || !path || !(await isFile(path))) return notFound()
    const [, id, slash, sub] = m
    // The page's URLs are relative to its directory
    if (!slash) return Response.redirect(new URL(`/view/html/${id}/`, req.url), 302)
    return await this.#page(req, path, id, sub)
  }

  /** A page's socket, at <id>/_ah/socket on the pages port */
  upgradePage(rest: string, query: URLSearchParams): ((ws: WebSocket) => void) | null {
    const m = rest.match(/^([^/]+)\/_ah\/socket$/)
    const path = m && pathOf(m[1])
    if (!path) return null
    return (ws) =>
      void this.files.connect(path, ws, locationOf(query), (_live, thread) => [
        thread.snapshot(true),
      ])
  }

  /** `sub` is the path after the file's page, /view/html/<id>/ */
  async #page(req: Request, path: string, id: string, sub: string): Promise<Response> {
    // A task list's Park, Done, and Resume buttons: the server sets its
    // status, without the agent
    if (sub === "_ah/tracker-status" && req.method === "POST") {
      if (!this.#trackers) return notFound()
      const { status }: { status?: unknown } = await req.json().catch(() => ({}))
      if (status !== "active" && status !== "parked" && status !== "done")
        return new Response("bad status", { status: 400 })
      if (!this.#trackers.setStatus(path, status))
        return new Response("not a tracker", { status: 404 })
      // The file didn't change, so its watch won't reload its pages
      this.files.pages(path).broadcast(JSON.stringify({ type: "reload" }))
      return new Response(null, { status: 204 })
    }
    if (sub === "_ah/request")
      return (
        (await threadRoute(req, "request", await this.files.thread(path))) ?? notFound()
      )
    if (sub.startsWith("_ah/")) return notFound()
    if (sub === "") {
      const query = new URL(req.url).searchParams
      const chat = query.get("chat") !== "off"
      const dashboard = query.get("in") === "dashboard"
      let html: string
      try {
        html = await readFile(path, "utf8")
      } catch {
        return new Response(`can't read ${path}`, { status: 404 })
      }
      const status = this.#trackers?.statusOf(path) ?? null
      return new Response(inject(html, id, { chat, dashboard, status }), {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      })
    }
    return await sibling(path, sub)
  }
}

const notFound = () => new Response("not found", { status: 404 })

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  )

/** A file next to the page, or under its directory, of a type a web page
 * loads (`types`) and outside dot directories, so a page can't read a
 * repo's `.git/config` or a key */
async function sibling(pagePath: string, sub: string): Promise<Response> {
  const dir = dirname(pagePath)
  let real: string
  try {
    real = await realpath(join(dir, decodeURIComponent(sub)))
    if (!plainlyUnder(await realpath(dir), real) || !(await stat(real)).isFile()) {
      return notFound()
    }
  } catch {
    return notFound()
  }
  const type = types[extname(real).toLowerCase()]
  if (!type) return notFound()
  const body = Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>
  return new Response(body, { headers: { "content-type": type, ...noStore } })
}

function indexPage(pages: FileInfo[]): Response {
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
