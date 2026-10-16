import { appendFile, readFile } from "node:fs/promises"
import {
  type Activity,
  PHASES,
  type Request,
  type RequestState,
  type ThreadEntry,
} from "../../core/model.ts"
import { isOneOf, isRecord } from "../../platform/guards.ts"

export { PHASES }

/** What a page posts: the request without what the log adds */
export type RequestInput = Pick<Request, "kind" | "text" | "args" | "replyTo">
/** What the agent posts about the requests it's handling */
export type ActivityInput = Pick<Activity, "phase" | "requests" | "workId" | "text">

/** The phases that end a request, which become its status */
const ENDINGS = ["done", "needs-reply", "error"] as const

/** A kind of request a subject type takes. The type validates its requests
 * with it and renders each into what the agent reads; nothing else reads
 * the kind. */
export interface RequestKind {
  /** Whether it takes the user's text, and must have it */
  text: "required" | "optional" | "none"
  /** Its arguments: whether each must be there, and its longest length */
  args?: Record<string, { required?: boolean; max?: number }>
  /** What the agent reads for it, after "Request <id>: " */
  render(request: Request): string
}
export type RequestKinds = Record<string, RequestKind>

/** What posting a request returns to the page */
export type RequestResult = { request: ThreadEntry & Request; agentConnected: boolean }
/** The thread as a page gets it: on connecting, and after each change */
export type ThreadSnapshot = {
  type: "thread"
  file: string
  entries: ThreadEntry[]
  requests: RequestState[]
  agentConnected: boolean
}

/** Enough of an entry's shape for `apply` to read it */
function isEntry(value: unknown): value is ThreadEntry {
  if (!isRecord(value) || typeof value.id !== "string") return false
  if (value.type === "request")
    return typeof value.kind === "string" && isRecord(value.args)
  return value.type === "activity" && Array.isArray(value.requests)
}

export class InputError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InputError("Expected a JSON object")
  return value
}
function string(body: Record<string, unknown>, key: string, required = false, max = 20000) {
  const value = body[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new InputError(`Invalid ${key}`)
  }
  return value
}
function identifier(body: Record<string, unknown>, key: string, required = false) {
  const value = string(body, key, required, 128)
  if (value !== undefined && !/^[\w-]+$/.test(value)) throw new InputError(`Invalid ${key}`)
  return value
}

/** A page's request, checked against the kinds its subject type takes */
export function parseRequest(value: unknown, kinds: RequestKinds): RequestInput {
  const body = record(value)
  const kind = body.kind
  if (typeof kind !== "string" || !Object.hasOwn(kinds, kind)) {
    throw new InputError("Invalid request kind")
  }
  const spec = kinds[kind]
  const given = body.args === undefined ? {} : record(body.args)
  const args: Record<string, string> = {}
  for (const [name, { required, max }] of Object.entries(spec.args ?? {})) {
    const arg = string(given, name, required, max)
    if (arg !== undefined) args[name] = arg
  }
  return {
    kind,
    text: spec.text === "none" ? undefined : string(body, "text", spec.text === "required"),
    args,
    replyTo: identifier(body, "replyTo"),
  }
}

export function parseActivity(value: unknown): ActivityInput {
  const body = record(value)
  const phase = body.phase
  if (!isOneOf(PHASES, phase)) {
    throw new InputError("Invalid activity phase")
  }
  const ids = body.requests ?? []
  if (!Array.isArray(ids) || ids.length > 100) throw new InputError("Invalid requests")
  const requests = [...new Set(ids.map((id) => identifier({ id }, "id", true)!))]
  if (phase !== "reply" && requests.length === 0) {
    throw new InputError("requests are required")
  }
  return {
    phase,
    requests,
    workId: identifier(body, "workId", requests.length > 0),
    text: string(body, "text", ["reply", "needs-reply", "error"].includes(phase)),
  }
}

// One append-only log is both the conversation history and the recovery source.
export class ThreadLog {
  entries: ThreadEntry[] = []
  requests = new Map<string, RequestState>()
  private path: string
  file: string
  private constructor(path: string, file: string) {
    this.path = path
    this.file = file
  }

  static async open(path: string, file: string) {
    const log = new ThreadLog(path, file)
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return log
      throw error
    }
    for (const line of source.split("\n")) {
      if (!line.trim()) continue
      // A crash mid-append leaves a partial line; one bad line shouldn't
      // lose the rest of the conversation
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        entry = null
      }
      if (isEntry(entry)) log.apply(entry)
      else console.error(`ah: skipping an unreadable line in ${path}`)
    }
    // Start the next append on a line of its own
    if (source && !source.endsWith("\n")) await appendFile(path, "\n")
    for (const state of log.requests.values()) {
      if (state.status === "working") state.status = "interrupted"
    }
    return log
  }

  private apply(entry: ThreadEntry) {
    this.entries.push(entry)
    if (entry.type === "request") {
      this.requests.set(entry.id, { id: entry.id, status: "waiting", updatedAt: entry.at })
      return
    }
    for (const id of entry.requests) {
      const state = this.requests.get(id)
      if (!state) continue
      if (entry.phase === "start") {
        state.status = "working"
        state.workId = entry.workId
      } else if (isOneOf(ENDINGS, entry.phase)) {
        state.status = entry.phase
      }
      state.updatedAt = entry.at
    }
  }

  // Callers serialize appends; the server runs them through one mutation queue.
  async request(input: RequestInput): Promise<ThreadEntry & Request> {
    if (input.replyTo && !this.requests.has(input.replyTo)) {
      throw new InputError("Unknown replyTo request", 404)
    }
    return this.append({ type: "request", ...input })
  }

  async activity(input: ActivityInput): Promise<ThreadEntry & Activity> {
    for (const id of input.requests) {
      const state = this.requests.get(id)
      if (!state) throw new InputError(`Unknown request: ${id}`, 404)
      if (state.status === "done") {
        throw new InputError(`Request already finished: ${id}`, 409)
      }
      if (
        input.phase !== "start" &&
        (state.workId !== input.workId || state.status !== "working")
      ) {
        throw new InputError(`Start this work before updating request: ${id}`, 409)
      }
    }
    return this.append({ type: "activity", ...input })
  }

  private async append<T extends Omit<Request, "id" | "at"> | Omit<Activity, "id" | "at">>(
    input: T,
  ) {
    const entry = {
      ...input,
      id: crypto.randomUUID(),
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
    }
    await appendFile(this.path, JSON.stringify(entry) + "\n")
    this.apply(entry as ThreadEntry)
    return entry
  }

  snapshot(agentConnected: boolean): ThreadSnapshot {
    return {
      type: "thread",
      file: this.file,
      entries: this.entries,
      requests: [...this.requests.values()],
      agentConnected,
    }
  }
}
