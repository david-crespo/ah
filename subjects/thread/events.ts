import { appendFile, readFile } from "node:fs/promises"
import {
  type Activity,
  PHASES,
  type Request,
  type RequestState,
  type ThreadEntry,
} from "../../model.ts"
import { isOneOf, isRecord } from "../../platform/guards.ts"

export { PHASES }

/** What a page posts: the request without what the log adds */
export type RequestInput = Pick<Request, "kind" | "text" | "args" | "replyTo">
/** What the agent posts about the requests it's handling */
export type ActivityInput = Pick<Activity, "phase" | "requests" | "text">

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
  /** What a page's conversation labels it with, after "You", and shows for
   * it; without this, its kind and its arguments */
  feed?(request: Request): { label?: string; body: string }
}
export type RequestKinds = Record<string, RequestKind>

/** What a page does with its batch: start one, which holds the requests
 * that follow; send them to the agent in one post; drop them; or take some
 * of them out */
export const BATCH_ACTIONS = ["open", "send", "discard", "remove"] as const
export type BatchInput = { action: (typeof BATCH_ACTIONS)[number]; requests: string[] }

/** What posting a request returns to the page: whether it went into the
 * batch rather than to the agent */
export type RequestResult = {
  request: ThreadEntry & Request
  agentConnected: boolean
  batched: boolean
}
/** The thread as a page gets it: on connecting, and after each change */
export type ThreadSnapshot = {
  type: "thread"
  /** The subject's path */
  subject: string
  entries: ThreadEntry[]
  requests: RequestState[]
  agentConnected: boolean
  /** Whether the page is batching its requests */
  batching: boolean
}

/** Lines of the log that aren't in the conversation: the requests a post
 * to an agent carried, and what the page did with its batch */
type Delivery = { type: "delivered"; requests: string[]; at: string }
type BatchLine = BatchInput & { type: "batch"; at: string }

const isDelivery = (value: unknown): value is Delivery =>
  isRecord(value) && value.type === "delivered" && Array.isArray(value.requests)
const isBatchLine = (value: unknown): value is BatchLine =>
  isRecord(value) &&
  value.type === "batch" &&
  isOneOf(BATCH_ACTIONS, value.action) &&
  Array.isArray(value.requests)

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

export function parseBatch(value: unknown): BatchInput {
  const body = record(value)
  if (!isOneOf(BATCH_ACTIONS, body.action)) throw new InputError("Invalid batch action")
  return { action: body.action, requests: requestIds(body) }
}

/** The request ids a post names, each once */
function requestIds(body: Record<string, unknown>): string[] {
  const ids = body.requests ?? []
  if (!Array.isArray(ids) || ids.length > 100) throw new InputError("Invalid requests")
  return [...new Set(ids.map((id) => identifier({ id }, "id", true)!))]
}

export function parseActivity(value: unknown): ActivityInput {
  const body = record(value)
  const phase = body.phase
  if (!isOneOf(PHASES, phase)) {
    throw new InputError("Invalid activity phase")
  }
  const requests = requestIds(body)
  if (phase !== "reply" && requests.length === 0) {
    throw new InputError("requests are required")
  }
  return {
    phase,
    requests,
    text: string(body, "text", ["reply", "needs-reply", "error"].includes(phase)),
  }
}

// One append-only log is both the conversation history and the recovery source.
export class ThreadLog {
  entries: ThreadEntry[] = []
  requests = new Map<string, RequestState>()
  /** The requests a post has carried to an agent */
  private delivered = new Set<string>()
  /** The request each answer answers */
  private replyTo = new Map<string, string>()
  /** Whether new requests go into the page's batch */
  batching = false
  private path: string
  /** The subject's path */
  subject: string
  private constructor(path: string, subject: string) {
    this.path = path
    this.subject = subject
  }

  static async open(path: string, subject: string) {
    const log = new ThreadLog(path, subject)
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
      if (isDelivery(entry)) for (const id of entry.requests) log.delivered.add(id)
      else if (isBatchLine(entry)) log.applyBatch(entry)
      else if (isEntry(entry)) log.apply(entry)
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
      const status = this.batching ? "batched" : "waiting"
      this.requests.set(entry.id, { id: entry.id, status, updatedAt: entry.at })
      if (entry.replyTo) this.replyTo.set(entry.id, entry.replyTo)
      return
    }
    for (const id of entry.requests) {
      const state = this.requests.get(id)
      if (!state) continue
      // Progress without a start starts the work
      if (entry.phase === "start" || entry.phase === "progress") {
        state.status = "working"
      } else if (isOneOf(ENDINGS, entry.phase)) {
        state.status = entry.phase
      }
      state.updatedAt = entry.at
    }
    if (!isOneOf(ENDINGS, entry.phase)) return
    // An answer that ends closes the open questions it answers, up the chain:
    // with its ending, or done when it asks again, since the open question is
    // then the answer
    const ending = entry.phase === "needs-reply" ? "done" : entry.phase
    for (const id of entry.requests) {
      let answered = this.replyTo.get(id)
      for (; answered && answered !== id; answered = this.replyTo.get(answered)) {
        const state = this.requests.get(answered)
        if (state?.status !== "needs-reply") break
        state.status = ending
        state.updatedAt = entry.at
      }
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
      if (input.phase === "reply" && state.status !== "working") {
        throw new InputError(`Start this work before replying on request: ${id}`, 409)
      }
    }
    return this.append({ type: "activity", ...input })
  }

  /** What's in the batch, oldest first */
  batched(): (ThreadEntry & Request)[] {
    return this.entries.filter(
      (e): e is ThreadEntry & Request =>
        e.type === "request" && this.requests.get(e.id)?.status === "batched",
    )
  }

  /** Do what the page asked with its batch. Returns the requests a send
   * released, for posting to the agent. */
  async batch(input: BatchInput): Promise<(ThreadEntry & Request)[]> {
    const batched = this.batched()
    if (input.action === "open" && this.batching) return []
    if (input.action !== "open" && !this.batching)
      throw new InputError("No batch is open", 409)
    for (const id of input.requests) {
      if (!batched.some((r) => r.id === id))
        throw new InputError(`Not in the batch: ${id}`, 409)
    }
    const line: BatchLine = { type: "batch", ...input, at: new Date().toISOString() }
    await appendFile(this.path, JSON.stringify(line) + "\n")
    this.applyBatch(line)
    return input.action === "send" ? batched : []
  }

  private applyBatch(line: BatchLine) {
    const batched = this.batched()
    switch (line.action) {
      case "open":
        this.batching = true
        return
      case "send":
        this.batching = false
        for (const { id } of batched)
          this.requests.set(id, { id, status: "waiting", updatedAt: line.at })
        return
      case "discard":
        this.batching = false
        return this.drop(batched.map((r) => r.id))
      case "remove":
        return this.drop(line.requests)
    }
  }

  /** Take requests out of the conversation, as if never made */
  private drop(ids: string[]) {
    const dropped = new Set(ids)
    this.entries = this.entries.filter((e) => !dropped.has(e.id))
    for (const id of ids) {
      this.requests.delete(id)
      this.replyTo.delete(id)
    }
  }

  /** Note that a post carried these requests to an agent */
  async deliver(requests: string[]) {
    const line: Delivery = { type: "delivered", requests, at: new Date().toISOString() }
    await appendFile(this.path, JSON.stringify(line) + "\n")
    for (const id of requests) this.delivered.add(id)
  }

  /** The requests still waiting that no post has carried to an agent,
   * oldest first */
  undelivered(): (ThreadEntry & Request)[] {
    return this.entries.filter(
      (e): e is ThreadEntry & Request =>
        e.type === "request" &&
        !this.delivered.has(e.id) &&
        this.requests.get(e.id)?.status === "waiting",
    )
  }

  private async append<T extends Omit<Request, "id" | "at"> | Omit<Activity, "id" | "at">>(
    input: T,
  ) {
    const entry = {
      ...input,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
    }
    await appendFile(this.path, JSON.stringify(entry) + "\n")
    this.apply(entry as ThreadEntry)
    return entry
  }

  snapshot(agentConnected: boolean): ThreadSnapshot {
    return {
      type: "thread",
      subject: this.subject,
      entries: this.entries,
      requests: [...this.requests.values()],
      agentConnected,
      batching: this.batching,
    }
  }
}
