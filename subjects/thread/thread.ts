// A thread: a page's requests to the agent it's bound to, and the agent's
// activity on them.
// The page's requests are posted into the session, each rendered by its
// subject type's kinds, and the agent's activity (`ah message respond`) is
// shown back on the page. One append-only log per file, under ~/.local/state/ah/<kind>/, is both
// the history and what a session catching up reads.
//
// The backend serving the page brings the transport to it (markdown's doc socket)
// and anything the agent should read ahead of each comment (markdown's edits
// since the last one).

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_PORT } from "../../platform/cli.ts"
import { ahStateDir } from "../../platform/paths.ts"
import { describeAddress, postTo, addressAlive } from "../../platform/session.ts"
import type { Address, FileKind, Request } from "../../core/model.ts"
import {
  type ActivityInput,
  type RequestInput,
  type RequestKinds,
  type RequestResult,
  ThreadLog,
} from "./events.ts"

function logPath(kind: FileKind, file: string): string {
  const dir = ahStateDir(kind)
  mkdirSync(dir, { recursive: true })
  // One log per file, named by its absolute path with slashes flattened
  return join(dir, file.replaceAll("/", "-") + ".comments.jsonl")
}

/** The one line before the requests in every post: where they're from,
 * and the command that answers them, so the agent doesn't have to work out
 * the file's path or the server's port. The skill explains the rest. */
export function header(
  { kind, title }: Pick<ThreadOptions, "kind" | "title">,
  file: string,
  port: number,
): string {
  const portFlag = port === DEFAULT_PORT ? "" : ` -p ${port}`
  const tool = title ?? kind[0].toUpperCase() + kind.slice(1)
  const respond = `ah message respond${portFlag} ${shellWord(file)} <phase> <request ids>`
  return `${tool} requests for ${file} (handle per /${kind} skill, answer with ${respond}):`
}

/** A path as one shell word, single-quoted only if it needs to be */
function shellWord(path: string): string {
  return /^[\w./~+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`
}

/** A request as the agent reads it */
export function render(request: Request, kinds: RequestKinds): string {
  const answering = request.replyTo ? `, answering ${request.replyTo}` : ""
  return `Request ${request.id}${answering}: ${kinds[request.kind].render(request)}`
}

/** The file, and where its comments go now: its agent's address, which
 * changes as the agent moves through sessions, or the session that opened
 * it */
export interface Bound {
  readonly path: string
  address(): Address | null
}

export interface ThreadOptions {
  /** The page's subject kind: where the log goes, and the skill the header
   * names */
  kind: FileKind
  /** The type's name in the header, if not its name capitalized */
  title?: string
  /** The requests the type takes */
  kinds: RequestKinds
  /** The server's, for telling the agent which one to answer */
  port: number
  /** Send a message to every page showing the thread */
  broadcast: (message: string) => void
  /** A line the agent should read before each request, if there is one */
  context?: () => Promise<string | null>
  /** Hear whether the thread holds requests no agent has taken */
  hold?: (held: boolean) => void
}

export class Thread {
  #file: Bound
  #log: ThreadLog
  #options: ThreadOptions
  #queue: Promise<unknown> = Promise.resolve()
  /** Whether the pages were last told an agent is there */
  #told: boolean | null = null
  /** Context no post has carried yet, kept for the requests it came with,
   * which are held until an agent turns up */
  #unsent: string[] = []

  private constructor(file: Bound, log: ThreadLog, options: ThreadOptions) {
    this.#file = file
    this.#log = log
    this.#options = options
  }

  static async open(file: Bound, options: ThreadOptions): Promise<Thread> {
    const log = await ThreadLog.open(logPath(options.kind, file.path), file.path)
    return new Thread(file, log, options)
  }

  /** Keep the context, the log, and delivery in that order, including when
   * several requests arrive at once */
  #serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn)
    this.#queue = next.catch(() => {})
    return next
  }

  /** For the page: the whole conversation, and whether a session is there to
   * read it. `replay` marks the one sent on connect. */
  snapshot(replay: boolean): string {
    const snapshot = this.#log.snapshot(addressAlive(this.#file.address()))
    return JSON.stringify({ ...snapshot, replay })
  }

  /** Requests and history, for the agent */
  state() {
    return this.#log.snapshot(addressAlive(this.#file.address()))
  }

  #broadcast() {
    this.#told = addressAlive(this.#file.address())
    const snapshot = this.#log.snapshot(this.#told)
    this.#options.broadcast(JSON.stringify({ ...snapshot, replay: false }))
  }

  get kinds(): RequestKinds {
    return this.#options.kinds
  }

  /** Log a request and post it to the session, with the context ahead of
   * it. A failed post leaves it waiting in the log, held for the next agent
   * to turn up, so it never fails the user's send. */
  request(input: RequestInput): Promise<RequestResult> {
    return this.#serially(async () => {
      await this.#takeContext()
      const request = await this.#log.request(input)
      const agentConnected = await this.#deliver([request])
      this.#hold()
      this.#broadcast()
      return { request, agentConnected }
    })
  }

  /** For when agents come and go, or the file is bound to another: send the
   * held requests that are still waiting, if an agent is there now, and
   * tell the pages if that changed. The log says which are held, so they
   * outlive the server. */
  refresh(): Promise<void> {
    return this.#serially(async () => {
      const alive = addressAlive(this.#file.address())
      const held = alive ? this.#log.undelivered() : []
      if (held.length) {
        await this.#takeContext()
        await this.#deliver(held)
      }
      this.#hold()
      if (alive !== this.#told) this.#broadcast()
    })
  }

  /** The agent's lifecycle posts and replies; never posted back to it */
  activity(input: ActivityInput) {
    return this.#serially(async () => {
      const entry = await this.#log.activity(input)
      // Finishing a held request takes it out of the held ones
      this.#hold()
      this.#broadcast()
      return entry
    })
  }

  async #takeContext() {
    const context = (await this.#options.context?.()) ?? null
    if (context !== null) this.#unsent.push(context)
  }

  #hold() {
    this.#options.hold?.(this.#log.undelivered().length > 0)
  }

  /** Post the requests, with the context no post has carried ahead of them,
   * and log that they went */
  async #deliver(requests: Request[]): Promise<boolean> {
    const address = this.#file.address()
    if (!address) return false
    const lines = [
      header(this.#options, this.#file.path, this.#options.port),
      ...this.#unsent,
      ...requests.map((request) => render(request, this.#options.kinds)),
    ]
    try {
      await postTo(address, lines.join("\n"))
    } catch (error) {
      console.error(`ah: could not reach ${describeAddress(address)}:`, error)
      return false
    }
    this.#unsent = []
    await this.#log.deliver(requests.map((request) => request.id))
    return true
  }
}
