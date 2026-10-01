import { appendFile, readFile } from "node:fs/promises"
import { isOneOf } from "../guards.ts"

export type UserInput = {
  kind: "message" | "comment" | "dellm"
  text?: string
  selection?: string
  prefix?: string
  suffix?: string
  embed?: string
  replyTo?: string
}

export const PHASES = [
  "start",
  "progress",
  "reply",
  "done",
  "needs-reply",
  "error",
] as const
/** The phases that end a request, which become its status */
const ENDINGS = ["done", "needs-reply", "error"] as const

export type ActivityInput = {
  kind: "activity"
  phase: (typeof PHASES)[number]
  requestIds: string[]
  workId?: string
  text?: string
}

export type Event = (UserInput | ActivityInput) & {
  id: string
  seq: number
  ts: string
  file: string
}
export type RequestState = {
  id: string
  status: "waiting" | "working" | "done" | "needs-reply" | "error" | "interrupted"
  workId?: string
  updatedAt: string
}
/** What posting a comment returns to the page */
export type CommentResult = { event: Event; agentConnected: boolean }
export type FeedSnapshot = {
  type: "conversation"
  file: string
  events: Event[]
  requests: RequestState[]
  agentConnected: boolean
}

/** Enough of an Event's shape for `apply` to read it */
function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  if (typeof e.id !== "string" || typeof e.kind !== "string") return false
  return e.kind !== "activity" || Array.isArray(e.requestIds)
}

export class InputError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Expected a JSON object")
  }
  return value as Record<string, unknown>
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

export function parseUser(value: unknown): UserInput {
  const body = record(value)
  const kind = body.kind
  if (kind !== "message" && kind !== "comment" && kind !== "dellm") {
    throw new InputError("Invalid message kind")
  }
  return {
    kind,
    text: string(body, "text", kind !== "dellm"),
    ...(kind === "message"
      ? {}
      : {
          selection: string(body, "selection", true),
          prefix: string(body, "prefix") ?? "",
          suffix: string(body, "suffix") ?? "",
          embed: string(body, "embed", false, 4000),
        }),
    replyTo: identifier(body, "replyTo"),
  }
}

export function parseActivity(value: unknown): ActivityInput {
  const body = record(value)
  const phase = body.phase
  if (!isOneOf(PHASES, phase)) {
    throw new InputError("Invalid activity phase")
  }
  const ids = body.requestIds ?? []
  if (!Array.isArray(ids) || ids.length > 100) throw new InputError("Invalid requestIds")
  const requestIds = [...new Set(ids.map((id) => identifier({ id }, "id", true)!))]
  if (phase !== "reply" && requestIds.length === 0) {
    throw new InputError("requestIds are required")
  }
  return {
    kind: "activity",
    phase,
    requestIds,
    workId: identifier(body, "workId", requestIds.length > 0),
    text: string(body, "text", ["reply", "needs-reply", "error"].includes(phase)),
  }
}

// One append-only log is both the conversation history and the recovery source.
export class ActivityLog {
  events: Event[] = []
  requests = new Map<string, RequestState>()
  private path: string
  file: string
  private constructor(path: string, file: string) {
    this.path = path
    this.file = file
  }

  static async open(path: string, file: string) {
    const log = new ActivityLog(path, file)
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
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        event = null
      }
      if (isEvent(event)) log.apply(event)
      else console.error(`ah: skipping an unreadable line in ${path}`)
    }
    // Start the next append on a line of its own
    if (source && !source.endsWith("\n")) await appendFile(path, "\n")
    for (const state of log.requests.values()) {
      if (state.status === "working") state.status = "interrupted"
    }
    return log
  }

  private apply(event: Event) {
    this.events.push(event)
    if (event.kind !== "activity") {
      this.requests.set(event.id, { id: event.id, status: "waiting", updatedAt: event.ts })
      return
    }
    for (const id of event.requestIds) {
      const state = this.requests.get(id)
      if (!state) continue
      if (event.phase === "start") {
        state.status = "working"
        state.workId = event.workId
      } else if (isOneOf(ENDINGS, event.phase)) {
        state.status = event.phase
      }
      state.updatedAt = event.ts
    }
  }

  // Callers serialize appends; the server runs them through one mutation queue.
  async append(input: UserInput | ActivityInput): Promise<Event> {
    if (input.kind === "activity") {
      for (const id of input.requestIds) {
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
    } else if (input.replyTo && !this.requests.has(input.replyTo)) {
      throw new InputError("Unknown replyTo request", 404)
    }
    const event = {
      ...input,
      id: crypto.randomUUID(),
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      file: this.file,
    } satisfies Event
    await appendFile(this.path, JSON.stringify(event) + "\n")
    this.apply(event)
    return event
  }

  snapshot(agentConnected: boolean): FeedSnapshot {
    return {
      type: "conversation",
      file: this.file,
      events: this.events,
      requests: [...this.requests.values()],
      agentConnected,
    }
  }
}
