// The files an app has open (markdown's, html's), keyed by absolute path, each
// with what the server keeps for it while it's open: the session its comments
// go to, the pages showing it, the conversation (Thread), and whatever the app
// keeps live for it (markdown's text and helix panes, html's reload watcher).
// Opening a file again rebinds it to the new session rather than opening a
// second copy.
//
// All of it is in memory. A restart forgets every open file, so its pages say
// it isn't open anymore until an agent opens it again; the conversation log,
// on disk, is still there when it does. Saving the open files to survive a
// restart was considered and dropped (2026-10-01): restarts mostly happen
// while working on ah itself, and it would have put session tokens on disk.

import type { WebSocket } from "ws"
import { Thread } from "../chat/thread.ts"
import { fileId } from "../id.ts"
import { describeSession, type Session, sessionAlive } from "../session.ts"

/** The pages showing a file, one socket each, which also carries the
 * thread's conversation */
export class Pages {
  #clients = new Set<WebSocket>()

  broadcast(message: string) {
    for (const ws of this.#clients) {
      try {
        ws.send(message)
      } catch {
        this.#clients.delete(ws)
      }
    }
  }

  /** `greeting` is sent on connect */
  connect(ws: WebSocket, greeting: string[]) {
    this.#clients.add(ws)
    for (const message of greeting) ws.send(message)
    ws.on("close", () => this.#clients.delete(ws))
    ws.on("error", () => this.#clients.delete(ws))
  }

  /** Tell open pages the file is closed so they stop reconnecting, and hang
   * up */
  close() {
    this.broadcast(JSON.stringify({ type: "closed" }))
    for (const ws of this.#clients) ws.close(1000, "file closed")
    this.#clients.clear()
  }
}

/** What an app keeps live for an open file, besides its pages and thread */
export interface Live {
  /** A line the agent should read before each comment, if there is one */
  context?(): Promise<string | null>
  /** Stop watching, for closing the file */
  close(): void
}

export interface FileApp<L extends Live> {
  /** In its URLs, where its logs go, and the skill the thread's header names */
  name: string
  /** The app's name in the thread's header, if not its name capitalized */
  title?: string
  /** Set up what the app keeps live for a file being opened */
  attach(path: string, pages: Pages): Promise<L>
}

export interface OpenFile<L extends Live> {
  /** In the URL: readable, and stable for a path across restarts */
  id: string
  path: string
  /** Where comments go: the session that last opened it with `ah app <name>
   * open`. Null when no session has, as for the dashboard's view. */
  session: Session | null
  openedAt: string
  pages: Pages
  thread: Thread
  live: L
}

/** An open file as the API shows it: never the token */
export interface FileInfo {
  id: string
  path: string
  url: string
  /** The harness and where posts go */
  session: string | null
  sessionAlive: boolean
  openedAt: string
}

export class OpenFiles<L extends Live> {
  #byId = new Map<string, OpenFile<L>>()
  // Opening reads the thread's log (and markdown's file), so two opens at
  // once share one
  #opening = new Map<string, Promise<OpenFile<L>>>()
  #port: number
  #pageOrigin: string
  readonly app: FileApp<L>

  /** `port` is the server's, for telling the agent which one to answer.
   * `pageOrigin` is where the pages are, if not on the server's own origin
   * (html's, on a port of their own). */
  constructor(port: number, app: FileApp<L>, pageOrigin = "") {
    this.#port = port
    this.app = app
    this.#pageOrigin = pageOrigin
  }

  /** Open the file, or rebind it to `session` if it's already open */
  async open(path: string, session: Session | null): Promise<OpenFile<L>> {
    const file = await this.ensure(path)
    file.session = session
    file.pages.broadcast(file.thread.snapshot(false))
    return file
  }

  /** Open the file if it isn't, leaving any binding alone: for views of it,
   * like the dashboard's, that have no session of their own */
  async ensure(path: string): Promise<OpenFile<L>> {
    const id = fileId(path)
    const open = this.#byId.get(id)
    if (open) return open
    let opening = this.#opening.get(id)
    if (!opening) {
      opening = this.#load(id, path).finally(() => this.#opening.delete(id))
      this.#opening.set(id, opening)
    }
    return await opening
  }

  async #load(id: string, path: string): Promise<OpenFile<L>> {
    const pages = new Pages()
    const live = await this.app.attach(path, pages)
    const base: Omit<OpenFile<L>, "thread"> = {
      id,
      path,
      session: null,
      openedAt: new Date().toISOString(),
      pages,
      live,
    }
    let file: OpenFile<L>
    try {
      // The thread reads the session from the file itself, so a rebind
      // reaches it
      file = Object.assign(base, {
        thread: await Thread.open(base, {
          app: this.app.name,
          title: this.app.title,
          port: this.#port,
          broadcast: (message) => pages.broadcast(message),
          context: async () => (await live.context?.()) ?? null,
        }),
      })
    } catch (e) {
      live.close()
      throw e
    }
    this.#byId.set(id, file)
    return file
  }

  get(id: string): OpenFile<L> | undefined {
    return this.#byId.get(id)
  }

  /** Stop watching it and hang up its pages; returns the closed file, if it
   * was open */
  close(id: string): OpenFile<L> | undefined {
    const file = this.#byId.get(id)
    if (!file) return undefined
    this.#byId.delete(id)
    file.live.close()
    file.pages.close()
    return file
  }

  /** Oldest first */
  list(): OpenFile<L>[] {
    return [...this.#byId.values()]
  }

  info(f: OpenFile<L>): FileInfo {
    return {
      id: f.id,
      path: f.path,
      url: `${this.#pageOrigin}/app/${this.app.name}/${f.id}/`,
      session: f.session ? describeSession(f.session) : null,
      sessionAlive: sessionAlive(f.session),
      openedAt: f.openedAt,
    }
  }
}
