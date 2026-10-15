// The files an app has open (markdown's, html's), keyed by absolute path, each
// with what the server keeps for it while it's open: the agent its comments
// go to, the pages showing it, the conversation (Thread), and whatever the app
// keeps live for it (markdown's text and helix panes, html's reload watcher).
// Opening a file again rebinds it to the new agent rather than opening a
// second copy.
//
// A file is bound to the agent that opened it, not to the session it was in,
// so comments follow the agent through /clear, Codex's /new, and a restart in
// its pane: the agent directory (the session registry) resolves its address
// when a comment is posted. The session that opened it is kept too, for an
// agent the directory can't place. If the agent is gone, comments go to
// another live agent in its tab, which is working from the same tracker.
//
// All of it is in memory. `ah server restart` asks the old server for the open files
// and their agents' addresses and opens them again in the new one, so the
// tokens never go on disk (saving the open files was considered and dropped on
// 2026-10-01 for that reason). Any other stop forgets every open file, so its
// pages say it isn't open anymore until an agent opens it again; the
// conversation log, on disk, is still there when it does.

import type { WebSocket } from "ws"
import { Thread } from "../chat/thread.ts"
import { fileId } from "../id.ts"
import type { AgentRef } from "../../app/sessions/registry.ts"
import { describeSession, type Session, sessionAlive } from "../session.ts"

/** Where agents can be reached, which changes as they go through sessions.
 * The server's is the session registry (app/sessions/routes.ts). */
export interface AgentDirectory {
  /** The id of the agent `agent` names (a ref, or an id already), noting
   * `session` as where it can be reached now */
  bind(agent: AgentRef | string, session: Session | null): string | null
  /** Where the agent can be reached now, if the directory knows */
  address(agent: string): Session | null
  /** Where another live agent in the agent's tab can be reached, for when it
   * can't */
  standIn(agent: string): Session | null
}

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
  /** Where comments go: the agent that last opened it with `ah app <name>
   * open`, by its id in the directory, and the session it opened it from,
   * for when the directory can't place the agent. Both null when no agent
   * has, as for the dashboard's view. */
  agent: string | null
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
  /** The agent's id */
  agent: string | null
  /** The harness and where posts go now */
  session: string | null
  sessionAlive: boolean
  openedAt: string
}

export interface OpenFilesOptions {
  pageOrigin?: string
  directory?: AgentDirectory | null
}

export class OpenFiles<L extends Live> {
  #byId = new Map<string, OpenFile<L>>()
  // Opening reads the thread's log (and markdown's file), so two opens at
  // once share one
  #opening = new Map<string, Promise<OpenFile<L>>>()
  #port: number
  #pageOrigin: string
  #directory: AgentDirectory | null
  readonly app: FileApp<L>

  /** `port` is the server's, for telling the agent which one to answer.
   * `pageOrigin` is where the pages are, if not on the server's own origin
   * (html's, on a port of their own). Without a directory, files are bound
   * to the session that opened them. */
  constructor(
    port: number,
    app: FileApp<L>,
    { pageOrigin = "", directory = null }: OpenFilesOptions = {},
  ) {
    this.#port = port
    this.app = app
    this.#pageOrigin = pageOrigin
    this.#directory = directory
  }

  /** Open the file, or rebind it if it's already open: to `agent`, from
   * `session`, which also tells the directory where the agent is now */
  async open(
    path: string,
    session: Session | null,
    agent: AgentRef | string | null = null,
  ): Promise<OpenFile<L>> {
    const file = await this.ensure(path)
    file.agent = (agent && this.#directory?.bind(agent, session)) ?? null
    file.session = session
    file.pages.broadcast(file.thread.snapshot(false))
    return file
  }

  /** Where the file's comments go now: its agent, or if that's gone, another
   * in the agent's tab */
  address(f: Pick<OpenFile<L>, "agent" | "session">): Session | null {
    const own = (f.agent && this.#directory?.address(f.agent)) || f.session
    if (sessionAlive(own) || !f.agent) return own
    return this.#directory?.standIn(f.agent) ?? own
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
      agent: null,
      session: null,
      openedAt: new Date().toISOString(),
      pages,
      live,
    }
    let file: OpenFile<L>
    try {
      // The thread asks for the address each time, so a rebind, or the
      // agent moving to another session, reaches it
      const bound = { path, address: () => this.address(base) }
      file = Object.assign(base, {
        thread: await Thread.open(bound, {
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

  /** For when agents come and go: each file's thread sends what it held
   * to whoever is there now, and tells its pages */
  refresh() {
    for (const f of this.#byId.values())
      f.thread.refresh().catch((e) => console.error(`ah: couldn't refresh ${f.path}:`, e))
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
    const session = this.address(f)
    return {
      id: f.id,
      path: f.path,
      url: `${this.#pageOrigin}/app/${this.app.name}/${f.id}/`,
      agent: f.agent,
      session: session ? describeSession(session) : null,
      sessionAlive: sessionAlive(session),
      openedAt: f.openedAt,
    }
  }
}
