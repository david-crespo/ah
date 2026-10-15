// A thread: the conversation between a page and the agent it's bound to.
// The user's comments and messages from the page are posted into the session,
// and the agent's activity (`ah app <name> respond`) is shown back on the
// page. One append-only log per file, under ~/.local/state/ah/<app>/, is both
// the history and what a session catching up reads.
//
// The app owning the page brings the transport to it (markdown's doc socket)
// and anything the agent should read ahead of each comment (markdown's edits
// since the last one).

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_PORT } from "../cli.ts"
import { ahStateDir } from "../paths.ts"
import { describeSession, postToSession, type Session, sessionAlive } from "../session.ts"
import {
  type ActivityInput,
  ActivityLog,
  type CommentResult,
  type Event,
  type UserInput,
} from "./events.ts"

function logPath(app: string, file: string): string {
  const dir = ahStateDir(app)
  mkdirSync(dir, { recursive: true })
  // One log per file, named by its absolute path with slashes flattened
  return join(dir, file.replaceAll("/", "-") + ".comments.jsonl")
}

/** The one line before the events in every post. The skill explains what
 * they are and how to answer, so the header only says where they're from. */
export function header(
  { app, title }: Pick<ThreadOptions, "app" | "title">,
  file: string,
  port: number,
): string {
  const where = port === DEFAULT_PORT ? "" : `, port ${port}`
  const tool = title ?? app[0].toUpperCase() + app.slice(1)
  return `${tool} event for ${file} (handle per /${app} skill${where}):`
}

/** The file, and where its comments go now: its agent's address, which
 * changes as the agent moves through sessions, or the session that opened
 * it */
export interface Bound {
  readonly path: string
  address(): Session | null
}

export interface ThreadOptions {
  /** The app the page belongs to: where the log goes, and the skill the
   * header names */
  app: string
  /** The app's name in the header, if not its name capitalized */
  title?: string
  /** The server's, for telling the agent which one to answer */
  port: number
  /** Send a message to every page showing the thread */
  broadcast: (message: string) => void
  /** A line the agent should read before each comment, if there is one */
  context?: () => Promise<string | null>
}

export class Thread {
  #file: Bound
  #log: ActivityLog
  #options: ThreadOptions
  #queue: Promise<unknown> = Promise.resolve()
  /** Comments no agent took, each with the lines its post had, to send to
   * the next one that turns up. In memory: after a restart, an agent catches
   * up on them with `pending`. */
  #held: { id: string; lines: string[] }[] = []
  /** Whether the pages were last told an agent is there */
  #told: boolean | null = null

  private constructor(file: Bound, log: ActivityLog, options: ThreadOptions) {
    this.#file = file
    this.#log = log
    this.#options = options
  }

  static async open(file: Bound, options: ThreadOptions): Promise<Thread> {
    const log = await ActivityLog.open(logPath(options.app, file.path), file.path)
    return new Thread(file, log, options)
  }

  /** Keep the context, the log, and delivery in that order, including when
   * several comments arrive at once */
  #serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn)
    this.#queue = next.catch(() => {})
    return next
  }

  /** For the page: the whole conversation, and whether a session is there to
   * read it. `replay` marks the one sent on connect. */
  snapshot(replay: boolean): string {
    const snapshot = this.#log.snapshot(sessionAlive(this.#file.address()))
    return JSON.stringify({ ...snapshot, replay })
  }

  /** Requests and history, for the agent */
  state() {
    return this.#log.snapshot(sessionAlive(this.#file.address()))
  }

  #broadcast() {
    this.#told = sessionAlive(this.#file.address())
    const snapshot = this.#log.snapshot(this.#told)
    this.#options.broadcast(JSON.stringify({ ...snapshot, replay: false }))
  }

  /** Log a comment or message and post it to the session, with the context
   * ahead of it. A failed post leaves it waiting in the log, and held for
   * the next agent to turn up, so it never fails the user's send. */
  comment(input: UserInput): Promise<CommentResult> {
    return this.#serially(async () => {
      const context = (await this.#options.context?.()) ?? null
      const event = await this.#log.append(input)
      const lines = [context, JSON.stringify(event)].filter((line) => line !== null)
      const agentConnected = await this.#deliver(lines)
      if (!agentConnected) this.#held.push({ id: event.id, lines })
      this.#broadcast()
      return { event, agentConnected }
    })
  }

  /** For when agents come and go: send the held comments that are still
   * waiting, if an agent is there now, and tell the pages if that changed */
  refresh(): Promise<void> {
    return this.#serially(async () => {
      const alive = sessionAlive(this.#file.address())
      if (alive && this.#held.length) {
        const requests = new Map(this.#log.snapshot(true).requests.map((r) => [r.id, r]))
        const waiting = this.#held.filter((h) => requests.get(h.id)?.status === "waiting")
        if (!waiting.length || (await this.#deliver(waiting.flatMap((h) => h.lines))))
          this.#held = []
      }
      if (alive !== this.#told) this.#broadcast()
    })
  }

  /** The agent's lifecycle posts and replies; never posted back to it */
  activity(input: ActivityInput): Promise<Event> {
    return this.#serially(async () => {
      const event = await this.#log.append(input)
      this.#broadcast()
      return event
    })
  }

  async #deliver(events: string[]): Promise<boolean> {
    const session = this.#file.address()
    if (!session) return false
    try {
      const first = header(this.#options, this.#file.path, this.#options.port)
      await postToSession(session, [first, ...events].join("\n"))
      return true
    } catch (error) {
      console.error(`ah: could not reach ${describeSession(session)}:`, error)
      return false
    }
  }
}
