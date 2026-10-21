// What a backend (markdown's, html's) keeps for files, by absolute path: the
// conversation (Thread) of any file something asks about, and for a file a
// page shows, its pages and whatever its type keeps live for it (markdown's
// text and helix panes, html's reload watcher). Nothing opens a file: a page's
// URL names its path, signed (subjects/id.ts), so a page that connects brings
// up the live state, and it stops a few seconds after the last page leaves,
// long enough for a reload. After a restart, pages reconnect on their own.
//
// A file is bound to the agent that showed it (`ah view open`), not to the
// session it was in, so comments follow the agent through /clear, Codex's
// /new, and a restart in its pane. The binding is the directory's (the core
// keeps it in the registry, on disk), and the directory resolves the agent's
// address when a comment is posted. If the agent is gone, comments go to
// another live agent in its tab, which is working from the same tracker. A
// file shown from a shell in Rex, in no agent session, is bound to an agent in
// the shell's tab, picked by the user if there are several.
//
// A file with requests no agent took is one the core keeps (its held paths),
// so they go out when an agent comes back. Threads load the first time
// they're needed; the log is on disk.

import { stat } from "node:fs/promises"
import type { WebSocket } from "ws"
import type { RequestKinds } from "../thread/events.ts"
import { Thread } from "../thread/thread.ts"
import { isOneOf } from "../../platform/guards.ts"
import { fileId } from "../id.ts"
import { GRACE_MS, Presence } from "../../platform/presence.ts"
import { describeAddress, addressAlive } from "../../platform/session.ts"
import type { Address, AgentId, AgentRef, FileKind } from "../../core/model.ts"

/** Which agent each file's requests go to, and where agents can be reached,
 * which changes as they go through sessions. The server's is the core, which
 * keeps the agent registry (core/core.ts). */
export interface AgentDirectory {
  /** The id of the agent `ref` names, if the directory knows it */
  agentId(ref: AgentRef): AgentId | null
  /** Note `address` as where the agent can be reached now */
  bind(agent: AgentId, address: Address | null): void
  /** Bind the file to `agent`: its requests go there from now on */
  bindFile(path: string, agent: AgentId): void
  /** The agent the file is bound to */
  binding(path: string): AgentId | null
  /** Where the file's requests go now: `target` if given, else the agent
   * it's bound to; if that one can't be reached, another live agent in its
   * tab */
  route(path: string, target?: AgentId | null): Address | null
  /** Note whether the file's thread holds requests no agent has taken */
  hold(path: string, held: boolean): void
}

/** Where a page is, as its socket's `in` says: a window or browser tab from
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
  #onCount: (count: number) => void

  /** `onCount` hears how many are connected each time that changes */
  constructor(onCount: (count: number) => void = () => {}) {
    this.#onCount = onCount
  }

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

  get count(): number {
    return this.#clients.size
  }

  /** `greeting` is sent on connect */
  connect(ws: WebSocket, greeting: string[], location: Location = "page") {
    this.#clients.set(ws, location)
    this.#counted()
    for (const message of greeting) ws.send(message)
    ws.on("close", () => this.#drop(ws))
    ws.on("error", () => this.#drop(ws))
  }

  #drop(ws: WebSocket) {
    if (this.#clients.delete(ws)) this.#counted()
  }

  #counted() {
    this.presence.update(this.#clients.size)
    this.#onCount(this.#clients.size)
  }

  /** Tell the windows and tabs showing the file that it's closed, so they
   * close and stop reconnecting, and hang up; the dashboard's stay. Returns
   * how many there were. */
  close(): number {
    const closing = [...this.#clients].filter(([, where]) => where !== "dashboard")
    for (const [ws] of closing) {
      try {
        ws.send(JSON.stringify({ type: "closed" }))
      } catch {
        /* gone already */
      }
      ws.close(1000, "file closed")
      this.#drop(ws)
    }
    return closing.length
  }
}

/** What a file type keeps live for a file while pages show it, besides its
 * pages and thread */
export interface Live {
  /** A line the agent should read before each request, if there is one */
  context?(): Promise<string | null>
  /** Stop watching, for when no page shows the file */
  close(): void
}

/** A subject type that's a file, as its backend's files need it */
export interface FileType<L extends Live> {
  /** In its URLs, where its logs go, and the skill the thread's header names */
  kind: FileKind
  /** The type's name in the thread's header, if not its name capitalized */
  title?: string
  /** The requests its pages send */
  kinds: RequestKinds
  /** Set up what the type keeps live for a file a page is showing */
  attach(path: string, pages: Pages): Promise<L>
}

/** A file as the API shows it */
export interface FileInfo {
  id: string
  path: string
  url: string
  /** The agent's id */
  agent: string | null
  /** The harness and where posts go now */
  address: string | null
  addressAlive: boolean
  /** Where its connected pages are */
  views: Location[]
}

export interface FilesOptions {
  pageOrigin?: string
}

export class Files<L extends Live> {
  // Each file a page has shown since the server started, kept for its
  // presence, which notices read after the pages are gone
  #pages = new Map<string, Pages>()
  // Attaching reads the file, so two pages at once share one
  #live = new Map<string, Promise<L>>()
  #teardowns = new Map<string, ReturnType<typeof setTimeout>>()
  #threads = new Map<string, Promise<Thread>>()
  #port: number
  #pageOrigin: string
  #directory: AgentDirectory
  readonly type: FileType<L>

  /** `port` is the server's, for telling the agent which one to answer, and
   * `directory` where each file's requests go. `pageOrigin` is where the
   * pages are, if not on the server's own origin (html's, on a port of their
   * own). */
  constructor(
    port: number,
    type: FileType<L>,
    directory: AgentDirectory,
    { pageOrigin = "" }: FilesOptions = {},
  ) {
    this.#port = port
    this.type = type
    this.#pageOrigin = pageOrigin
    this.#directory = directory
  }

  /** The id of the agent `ref` names, if the directory knows it */
  agentId(ref: AgentRef): AgentId | null {
    return this.#directory.agentId(ref)
  }

  /** For `ah view open`: bind the file to `agent`, if given, which can be
   * reached at `from`, and expect a page, which is on its way */
  async bind(path: string, from: Address | null, agent: AgentId | null): Promise<FileInfo> {
    if (agent) {
      this.#directory.bind(agent, from)
      this.#directory.bindFile(path, agent)
    }
    this.pages(path).presence.expect()
    // Send this agent what no agent took, and tell the pages if it's there
    await (await this.thread(path)).refresh()
    return this.info(path)
  }

  /** The agent the file is bound to */
  binding(path: string): AgentId | null {
    return this.#directory.binding(path)
  }

  /** The info of a file to show without binding it, like the dashboard's;
   * null if it isn't a readable file */
  async show(path: string): Promise<FileInfo | null> {
    try {
      if (!(await stat(path)).isFile()) return null
    } catch {
      return null
    }
    return this.info(path)
  }

  /** The pages showing the file */
  pages(path: string): Pages {
    let pages = this.#pages.get(path)
    if (!pages) {
      pages = new Pages((count) => this.#counted(path, count))
      this.#pages.set(path, pages)
    }
    return pages
  }

  /** A page's socket: counted at once, so the live state stays up, and sent
   * `greeting` once it's up */
  async connect(
    path: string,
    ws: WebSocket,
    location: Location,
    greeting: (live: L, thread: Thread) => string[],
  ) {
    this.pages(path).connect(ws, [], location)
    try {
      const [live, thread] = await Promise.all([this.live(path), this.thread(path)])
      if (ws.readyState === ws.OPEN)
        for (const message of greeting(live, thread)) ws.send(message)
    } catch (e) {
      console.error(`ah: couldn't show ${path}:`, e)
      ws.close(1011, "couldn't show the file")
    }
  }

  /** What the type keeps live for the file, started if no page has it yet */
  live(path: string): Promise<L> {
    let live = this.#live.get(path)
    if (!live) {
      live = this.type.attach(path, this.pages(path))
      live.catch(() => this.#live.delete(path))
      this.#live.set(path, live)
      // Stopped again unless a page shows it
      this.#counted(path, this.pages(path).count)
    }
    return live
  }

  /** With no page left, stop the live state, unless one comes back in time,
   * as on a reload */
  #counted(path: string, count: number) {
    clearTimeout(this.#teardowns.get(path))
    this.#teardowns.delete(path)
    if (count) return
    const timer = setTimeout(() => {
      this.#teardowns.delete(path)
      const live = this.#live.get(path)
      this.#live.delete(path)
      live?.then((l) => l.close()).catch(() => {})
    }, GRACE_MS)
    // Nothing to wait for at exit
    timer.unref?.()
    this.#teardowns.set(path, timer)
  }

  /** The file's thread, loaded the first time it's asked for */
  thread(path: string): Promise<Thread> {
    let thread = this.#threads.get(path)
    if (!thread) {
      // The thread asks for the address each time, so a rebind, or the
      // agent moving to another session, reaches it
      const bound = { path, address: () => this.#directory.route(path) }
      thread = Thread.open(bound, {
        kind: this.type.kind,
        title: this.type.title,
        kinds: this.type.kinds,
        port: this.#port,
        broadcast: (message) => this.#pages.get(path)?.broadcast(message),
        context: async () => {
          const live = this.#live.get(path)
          return (live && (await (await live).context?.())) ?? null
        },
        hold: (held) => this.#directory.hold(path, held),
      })
      // A log it couldn't read is tried again next time
      thread.catch(() => this.#threads.delete(path))
      this.#threads.set(path, thread)
    }
    return thread
  }

  /** For when agents come and go: each loaded thread, and those of `held`,
   * files with requests no agent took, sends what it held to whoever is
   * there now, and tells its pages */
  refresh(held: string[] = []) {
    const paths = new Set([...this.#threads.keys(), ...held])
    for (const path of paths) {
      this.thread(path)
        .then((t) => t.refresh())
        .catch((e) => console.error(`ah: couldn't refresh ${path}:`, e))
    }
  }

  /** Close the windows and tabs showing the file; how many there were */
  close(path: string): number {
    return this.#pages.get(path)?.close() ?? 0
  }

  /** The files pages show now, in the order they were first shown */
  shown(): string[] {
    return [...this.#pages].filter(([, p]) => p.count).map(([path]) => path)
  }

  /** Every file a page has shown, with whether a window does now or did a
   * moment ago, for the agent's notices */
  presence(): { path: string; open: boolean }[] {
    return [...this.#pages].map(([path, p]) => ({ path, open: p.presence.open() }))
  }

  /** How many pages are connected, for the server's status */
  get pageCount(): number {
    return [...this.#pages.values()].reduce((n, p) => n + p.count, 0)
  }

  info(path: string): FileInfo {
    const address = this.#directory.route(path)
    const id = fileId(path)
    return {
      id,
      path,
      url: `${this.#pageOrigin}/view/${this.type.kind}/${id}/`,
      agent: this.binding(path),
      address: address ? describeAddress(address) : null,
      addressAlive: addressAlive(address),
      views: this.#pages.get(path)?.locations ?? [],
    }
  }
}
