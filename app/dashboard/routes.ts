// The dashboard's routes, under /app/dashboard/: the page, and the SSE stream
// it follows. The server follows Rex (host/rex.ts) and hands each snapshot
// to onSnapshot; the dashboard keeps a live jj log for
// every open workspace (jj.ts), and pushes both to the page (page.html, with
// its script in client.ts), along with each tab's file, its agent's
// (tab_files.ts), which the page shows with the markdown app's <ah-markdown>
// element, or in a frame for an html file. The focused workspace gets
// snapshotted once edits settle, so @ stays current between jj commands.

import { readFile } from "node:fs/promises"
import { assetPath } from "../../host/assets.ts"
import { ClientBundles } from "../../host/bundle.ts"
import type { HtmlApp } from "../html/routes.ts"
import type { MarkdownApp } from "../markdown/routes.ts"
import type { SessionsApp } from "../sessions/routes.ts"
import { selectWindow, type Snapshot } from "../../host/rex.ts"
import { LogWatcher, SnapshotWatcher } from "./jj.ts"
import { tabFiles } from "./tab_files.ts"
import { focusedRoot, resolve, rootFinder, type State } from "./workspace.ts"

// Changes on every server start. The page reloads when it reconnects to a
// different server, so restarting the server is enough to pick up page edits.
const SERVER_VERSION = String(Date.now())

const encoder = new TextEncoder()

type Client = ReadableStreamDefaultController<Uint8Array>

const send = (c: Client, event: string, data: string) =>
  c.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))

const logEvent = (root: string, html: string) => JSON.stringify({ root, html })

/** A tab's file as the page shows it: `frame` for an html page, in an
 * <iframe> of `url`, otherwise in <ah-markdown> */
interface ShownDoc {
  path: string
  url: string
  frame: boolean
}

const docEvent = (tab: string, doc: ShownDoc | null) =>
  JSON.stringify({
    tab,
    path: doc?.path ?? null,
    url: doc?.url ?? null,
    frame: doc?.frame ?? false,
  })

export interface DashboardOptions {
  /** null turns off snapshotting the focused workspace */
  snapshotDelayMs: number | null
  /** The page shows each file with <ah-markdown> or in a frame of an html
   * page, so the app has to hold the file open before the page hears about it */
  markdown: MarkdownApp
  html: HtmlApp
  /** The agents, whose files the tabs show */
  sessions: SessionsApp
}

export class Dashboard {
  #page = readFile(assetPath("app/dashboard/page.html"), "utf8")
  #bundles = new ClientBundles("dashboard")
  #state: State = { focused: null, tabs: [] }
  #stateJson = JSON.stringify(this.#state)
  #logs = new Map<string, LogWatcher>()
  #snapshotter: SnapshotWatcher | null = null
  #clients = new Set<Client>()
  #snapshot: Snapshot | null = null
  /** tab -> its file */
  #files = new Map<string, string>()
  /** tab -> what the page was last told to show */
  #shown = new Map<string, ShownDoc>()
  #docQueue: Promise<void> = Promise.resolve()

  readonly options: DashboardOptions

  constructor(options: DashboardOptions) {
    this.options = options
    options.sessions.subscribe(() => this.#syncFiles())
  }

  /** Each tab's file, from the last snapshot and the registry; tells the
   * page about the ones that changed */
  #syncFiles() {
    if (!this.#snapshot) return
    const ids = new Set(this.#state.tabs.map((t) => t.id))
    const next = tabFiles(this.#snapshot, ids, this.options.sessions.registry)
    for (const tab of new Set([...this.#files.keys(), ...next.keys()])) {
      const path = next.get(tab) ?? null
      if ((this.#files.get(tab) ?? null) === path) continue
      // One at a time, since show takes a moment: two quick changes for a
      // tab would otherwise broadcast whichever finished last
      this.#docQueue = this.#docQueue.then(async () => {
        // Also reopens it if someone closed it
        const shown = path && (await this.#show(path))
        if (shown) this.#shown.set(tab, shown)
        else this.#shown.delete(tab)
        this.#broadcast("doc", docEvent(tab, shown || null))
      })
    }
    this.#files = next
  }

  /** Open the file in the app that shows it. An html page's conversation is
   * hidden: its buttons and comments wake the agent, which answers in the
   * terminal. And it's dark and see-through, to match the dashboard. */
  async #show(path: string): Promise<ShownDoc | null> {
    if (/\.html?$/i.test(path)) {
      const info = await this.options.html.show(path)
      return info && { path, url: `${info.url}?chat=off&in=dashboard`, frame: true }
    }
    const info = await this.options.markdown.show(path)
    return info && { path, url: info.url, frame: false }
  }

  onSnapshot(snapshot: Snapshot) {
    // A fresh finder each time: a cached root can be removed (`jjw rm` with
    // a tab still in it), and a cached miss can become a workspace
    this.#snapshot = snapshot
    this.#setState(resolve(snapshot, rootFinder(), this.#state.focused))
    // Tabs open and close
    this.#syncFiles()
  }

  #setState(next: State) {
    const nextJson = JSON.stringify(next)
    if (nextJson === this.#stateJson) return
    this.#state = next
    this.#stateJson = nextJson
    this.#syncWatchers()
    this.#broadcast("state", this.#stateJson)
  }

  /** How many pages are following the stream */
  get pages(): number {
    return this.#clients.size
  }

  #broadcast(event: string, data: string) {
    for (const c of this.#clients) {
      try {
        send(c, event, data)
      } catch {
        this.#clients.delete(c)
      }
    }
  }

  // A log watcher for every open workspace, not only the focused one, so a
  // tab switch shows an up-to-date log straight from the page's cache.
  #syncWatchers() {
    const open = new Set(this.#state.tabs.map((t) => t.root))
    for (const [root, watcher] of this.#logs) {
      if (open.has(root)) continue
      watcher.close()
      this.#logs.delete(root)
    }
    for (const root of open) {
      if (this.#logs.has(root)) continue
      this.#logs.set(
        root,
        new LogWatcher(root, (html) => this.#broadcast("jj", logEvent(root, html))),
      )
    }
    // Only the focused workspace gets snapshotted: it's the one on screen, and
    // watching every file in every open workspace would be wasteful
    const focused = focusedRoot(this.#state)
    if (this.#snapshotter?.root !== focused) {
      this.#snapshotter?.close()
      const delay = this.options.snapshotDelayMs
      this.#snapshotter =
        focused && delay !== null ? new SnapshotWatcher(focused, delay) : null
    }
  }

  /** `rest` is the path after /app/dashboard/ */
  async handle(req: Request, rest: string): Promise<Response> {
    if (rest === "") {
      this.#bundles.prebuild("client.js")
      return new Response(await this.#page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    if (rest === "events") return this.#events()
    if (rest === "focus" && req.method === "POST") return await this.#focus(req)
    return new Response("not found", { status: 404 })
  }

  /** Show a tab in Rex, for a click on its chip, leaving focus on the dashboard */
  async #focus(req: Request): Promise<Response> {
    const { tab: id }: { tab?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    try {
      await selectWindow(tab.session, tab.id)
    } catch (e) {
      console.error("ah:", e)
      return new Response("couldn't focus the tab", { status: 502 })
    }
    // Rex in the background may not report the switch until it's in front,
    // so the dashboard follows the click itself
    this.#setState({ ...this.#state, focused: tab.id })
    return new Response(null, { status: 204 })
  }

  #events(): Response {
    let controller: Client
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
        this.#clients.add(c)
        // Reconnect soon after a restart, so the page is back before a command
        // looks for one to show something in (EventSource waits seconds by
        // default)
        c.enqueue(encoder.encode("retry: 500\n\n"))
        send(c, "hello", JSON.stringify({ version: SERVER_VERSION }))
        send(c, "state", this.#stateJson)
        for (const [root, watcher] of this.#logs) {
          if (watcher.html !== null) send(c, "jj", logEvent(root, watcher.html))
        }
        for (const [tab, doc] of this.#shown) send(c, "doc", docEvent(tab, doc))
      },
      cancel: () => {
        this.#clients.delete(controller)
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }
}
