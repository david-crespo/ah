// opencode sessions, followed from opencode's own service rather than hooks.
// Every opencode 2 TUI is a client of one background service that runs all
// the sessions, and the service streams their events as SSE from
// /api/event. The ones that matter here:
//
//   session.created              {sessionID, location: {directory}, parentID?}
//   session.execution.started    {sessionID}     a turn begins
//   session.execution.succeeded  {sessionID}     ... and ends; or .failed,
//                                                .interrupted
//   session.renamed              {sessionID, title}
//
// They become the same registry events Claude's and Codex's hooks post,
// without a block: the service's env is the shell's that started it, so
// the registry finds the block from the TUI processes (tuis.ts). The
// summary is opencode's own title for the session, which it writes on the
// first prompt and the user can rename. Child sessions (subagents) are
// skipped so they can't claim the tab from their parent.

import { opencodeService, processRunning } from "../platform/session.ts"
import { abbreviatePath } from "./hook.ts"
import type { HookEventName, RegistryEvent } from "./registry.ts"
import type { Core } from "./core.ts"

export type OpencodeUpdate =
  | { kind: "event"; event: HookEventName; session: string; cwd: string | null }
  | { kind: "title"; session: string; title: string }
  | { kind: "child"; session: string }

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** One event off the stream, as what the registry needs from it */
export function readUpdate(raw: unknown): OpencodeUpdate | null {
  if (!raw || typeof raw !== "object") return null
  const { type, data } = raw as { type?: unknown; data?: Record<string, unknown> }
  const session = str(data?.sessionID)
  if (!session) return null
  switch (type) {
    case "session.created": {
      if (str(data?.parentID)) return { kind: "child", session }
      const location = data?.location as { directory?: unknown } | undefined
      return {
        kind: "event",
        event: "SessionStart",
        session,
        cwd: str(location?.directory),
      }
    }
    case "session.execution.started":
      return { kind: "event", event: "UserPromptSubmit", session, cwd: null }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { kind: "event", event: "Stop", session, cwd: null }
    case "session.renamed": {
      const title = str(data?.title)
      return title ? { kind: "title", session, title } : null
    }
    default:
      return null
  }
}

interface Service {
  url: string
  auth: string
}

interface SessionInfo {
  cwd: string | null
  title: string | null
  child: boolean
}

async function fetchSession(service: Service, id: string): Promise<SessionInfo | null> {
  try {
    const res = await fetch(new URL(`/api/session/${id}`, service.url), {
      headers: { authorization: service.auth },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Record<string, unknown> }
    const s = body.data ?? (body as Record<string, unknown>)
    const location = s.location as { directory?: unknown } | undefined
    return { cwd: str(location?.directory), title: str(s.title), child: !!str(s.parentID) }
  } catch {
    return null
  }
}

/** Follow the service while it runs, and look for it again when it stops
 * (each TUI starts one if none is running) */
export async function watchOpencode(core: Core, retryMs = 5000) {
  // What each session is, from session.created or else the service, so a
  // turn's events (which carry only the id) have a directory
  const known = new Map<string, SessionInfo>()
  for (;;) {
    const found = opencodeService()
    if (found && processRunning(found.pid)) {
      const auth = `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}`
      await follow({ url: found.url, auth }, core, known).catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs))
  }
}

async function follow(service: Service, core: Core, known: Map<string, SessionInfo>) {
  const res = await fetch(new URL("/api/event", service.url), {
    headers: { authorization: service.auth, accept: "text/event-stream" },
  })
  if (!res.ok || !res.body) return
  let buffer = ""
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      let raw: unknown
      try {
        raw = JSON.parse(line.slice(5))
      } catch {
        continue
      }
      const update = readUpdate(raw)
      if (update) await apply(service, core, known, update)
    }
  }
}

async function apply(
  service: Service,
  core: Core,
  known: Map<string, SessionInfo>,
  update: OpencodeUpdate,
) {
  if (update.kind === "child") {
    known.set(update.session, { cwd: null, title: null, child: true })
    return
  }
  let info = known.get(update.session)
  if (update.kind === "event" && update.event === "SessionStart") {
    info = { cwd: update.cwd, title: null, child: false }
    known.set(update.session, info)
  }
  // A session that started before ah was following: ask the service
  if (!info) {
    const fetched = await fetchSession(service, update.session)
    if (!fetched) return
    info = fetched
    known.set(update.session, info)
  }
  if (info.child) return
  if (update.kind === "title") return core.retitle(update.session, update.title)
  const event: RegistryEvent = {
    kind: "hook",
    event: update.event,
    harness: "opencode",
    session: update.session,
    block: null,
    process: null,
    label: info.cwd ? abbreviatePath(info.cwd) : "",
    cwd: info.cwd,
  }
  core.receive(event)
  // Its title, once, for a session first seen mid-life
  if (info.title) {
    core.retitle(update.session, info.title)
    info.title = null
  }
}
