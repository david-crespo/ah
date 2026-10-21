// The files a backend has open (markdown's, html's), keyed by absolute path, each
// with what the server keeps for it while it's open: the agent its comments
// go to, the pages showing it, the conversation (Thread), and whatever its type
// keeps live for it (markdown's text and helix panes, html's reload watcher).
// Opening a file again rebinds it to the new agent rather than opening a
// second copy.
//
// A file is bound to the agent that opened it, not to the session it was in,
// so comments follow the agent through /clear, Codex's /new, and a restart in
// its pane: the agent directory (the agent registry) resolves its address
// when a comment is posted. The session that opened it is kept too, for an
// agent the directory can't place. If the agent is gone, comments go to
// another live agent in its tab, which is working from the same tracker.
// A file opened from a shell in Rex, in no agent session, is bound to an
// agent in the shell's tab, picked by the user if there are several.
//
// All of it is in memory. `ah server restart` asks the old server for the open files
// and their agents' addresses and opens them again in the new one, so the
// tokens never go on disk (saving the open files was considered and dropped on
// 2026-10-01 for that reason). Any other stop forgets every open file, so its
// pages say it isn't open anymore until an agent opens it again; the
// conversation log, on disk, is still there when it does.

import { stat } from "node:fs/promises"
import type { WebSocket } from "ws"
import type { RequestKinds } from "../thread/events.ts"
import { Thread } from "../thread/thread.ts"
import { isOneOf } from "../../platform/guards.ts"
import { fileId } from "../id.ts"
import { Presence } from "../../platform/presence.ts"
import { describeAddress, addressAlive } from "../../platform/session.ts"
import type { Address, AgentId, AgentRef, Binding, FileKind } from "../../core/model.ts"

/** Where agents can be reached, which changes as they go through sessions.
 * The server's is the core, which keeps the agent registry (core/core.ts). */
export interface AgentDirectory {
  /** The id of the agent `ref` names, if the directory knows it */
  agentId(ref: AgentRef): AgentId | null
  /** Note `address` as where the agent can be reached now */
  bind(agent: AgentId, address: Address | null): void
  /** Where the agent can be reached now, if the directory knows */
  address(agent: string): Address | null
  /** Where another live agent in the agent's tab can be reached, for when it
   * can't */
  standIn(agent: string): Address | null
}

/** Where a page is, as its socket's `in` says: a Chrome window or tab from
 * `ah view open`, or the dashboard's doc slot */
export const LOCATIONS = ["window", "tab", "dashboard"] as const
export type Location = (typeof LOCATIONS)[number] | "page"

/** A page's location from its socket's query, "page" if it doesn't say */
export function locationOf(query: URLSearchParams): Location {
  const where = query.get("in")
  return isOneOf(LOCATIONS, where) ? where : "page"
}

/** The pages showing a file, one socket each, which also carries the
 * thread's conversation */
export class Pages {
  #clients = new Map<WebSocket, Location>()
  /** Whether any window shows the file, for telling its agent when none
   * does (core/notices.ts) */
  readonly presence = new Presence()

  broadcast(message: string) {
    for (const ws of this.#clients.keys()) {
      try {
        ws.send(message)
      } catch {
        this.#drop(ws)
      }
    }
  }

  /** Where each connected page is, oldest first */
  get locations(): Location[] {
    return [...this.#clients.values()]
  }

  /** `greeting` is sent on connect */
  connect(ws: WebSocket, greeting: string[], location: Location = "page") {
    this.#clients.set(ws, location)
    this.presence.update(this.#clients.size)
    for (const message of greeting) ws.send(message)
    ws.on("close", () => this.#drop(ws))
    ws.on("error", () => this.#drop(ws))
  }

  #drop(ws: WebSocket) {
    this.#clients.delete(ws)
    this.presence.update(this.#clients.size)
  }

  /** Tell open pages the file is closed so they stop reconnecting, and hang
   * up */
  close() {
    this.broadcast(JSON.stringify({ type: "closed" }))
    for (const ws of this.#clients.keys()) ws.close(1000, "file closed")
    this.#clients.clear()
    this.presence.update(0)
  }
}

/** What a file type keeps live for an open file, besides its pages and thread */
export interface Live {
  /** A line the agent should read before each request, if there is one */
  context?(): Promise<string | null>
  /** Stop watching, for closing the file */
  close(): void
}

/** A subject type that's a file, as its backend's open files need it */
export interface FileType<L extends Live> {
  /** In its URLs, where its logs go, and the skill the thread's header names */
  kind: FileKind
  /** The type's name in the thread's header, if not its name capitalized */
  title?: string
  /** The requests its pages send */
  kinds: RequestKinds
  /** Set up what the type keeps live for a file being opened */
  attach(path: string, pages: Pages): Promise<L>
}

export interface OpenFile<L extends Live> {
  /** In the URL: readable, and stable for a path across restarts */
  id: string
  path: string
  /** Where comments go: the agent that last opened it with `ah view
   * open`. Both null when no agent has, as for the dashboard's view. */
  binding: Binding
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
  address: string | null
  addressAlive: boolean
  openedAt: string
  /** Where its connected pages are */
  views: Location[]
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
  readonly type: FileType<L>

  /** `port` is the server's, for telling the agent which one to answer.
   * `pageOrigin` is where the pages are, if not on the server's own origin
   * (html's, on a port of their own). Without a directory, files are bound
   * to the session that opened them. */
  constructor(
    port: number,
    type: FileType<L>,
    { pageOrigin = "", directory = null }: OpenFilesOptions = {},
  ) {
    this.#port = port
    this.type = type
    this.#pageOrigin = pageOrigin
    this.#directory = directory
  }

  /** The id of the agent `ref` names, if there's a directory that knows it */
  agentId(ref: AgentRef): AgentId | null {
    return this.#directory?.agentId(ref) ?? null
  }

  /** Open the file, or rebind it if it's already open: to `agent`, opened
   * from `from`, which also tells the directory where the agent is now */
  async open(
    path: string,
    from: Address | null,
    agent: AgentId | null = null,
  ): Promise<OpenFile<L>> {
    const file = await this.ensure(path)
    if (agent) this.#directory?.bind(agent, from)
    file.binding = { agent: this.#directory ? agent : null, openedFrom: from }
    // Its window may be opening now
    file.pages.presence.expect()
    // Send this agent what no agent took, and tell the pages if it's there
    await file.thread.refresh()
    return file
  }

  /** Where the file's comments go now: its agent, or if that's gone, another
   * in the agent's tab */
  address({ agent, openedFrom }: Binding): Address | null {
    const own = (agent && this.#directory?.address(agent)) || openedFrom
    if (addressAlive(own) || !agent) return own
    return this.#directory?.standIn(agent) ?? own
  }

  /** Open the file if it isn't, leaving any binding alone: for views of it,
   * like the dashboard's, that have no agent of their own */
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

  /** `ensure` for a view that shows the file without binding it, like the
   * dashboard's; null if it isn't a readable file */
  async show(path: string): Promise<FileInfo | null> {
    try {
      if (!(await stat(path)).isFile()) return null
      return this.info(await this.ensure(path))
    } catch {
      return null
    }
  }

  async #load(id: string, path: string): Promise<OpenFile<L>> {
    const pages = new Pages()
    const live = await this.type.attach(path, pages)
    const base: Omit<OpenFile<L>, "thread"> = {
      id,
      path,
      binding: { agent: null, openedFrom: null },
      openedAt: new Date().toISOString(),
      pages,
      live,
    }
    let file: OpenFile<L>
    try {
      // The thread asks for the address each time, so a rebind, or the
      // agent moving to another session, reaches it
      const bound = { path, address: () => this.address(base.binding) }
      file = Object.assign(base, {
        thread: await Thread.open(bound, {
          kind: this.type.kind,
          title: this.type.title,
          kinds: this.type.kinds,
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
    const address = this.address(f.binding)
    return {
      id: f.id,
      path: f.path,
      url: `${this.#pageOrigin}/view/${this.type.kind}/${f.id}/`,
      agent: f.binding.agent,
      address: address ? describeAddress(address) : null,
      addressAlive: addressAlive(address),
      openedAt: f.openedAt,
      views: f.pages.locations,
    }
  }
}
