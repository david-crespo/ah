// The sessions app's routes, under /app/sessions/: GET the sessions as JSON,
// from the registry and Rex's latest snapshot (`?all` includes ones
// that aren't in a terminal or running any more), and POST `event` for the
// hooks (cli.ts) to report into the registry.
//
// The app owns the registry. Each event is applied synchronously, then the
// registry is saved (debounced) and listeners hear which terminals changed;
// a prompt's summary runs after, and is applied the same way when it's
// ready. Events and summary outcomes are logged to registry-events.jsonl for
// working out afterwards why a title was what it was.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord } from "../../host/guards.ts"
import type { Snapshot } from "../../host/rex.ts"
import { focusedTerminal, pickTerminal, readTuis } from "./tuis.ts"
import {
  apply,
  applySummary,
  emptyRegistry,
  HARNESSES,
  HOOK_EVENTS,
  loadRegistry,
  prune,
  type Registry,
  type RegistryEvent,
  registryFile,
  saveRegistry,
  type SummaryJob,
} from "./registry.ts"
import { type AgentSession, listSessions, readClaudeProcesses } from "./sessions.ts"
import { buildSummaryPayload, generateSummary } from "./summary.ts"

/** In a terminal that still exists, or running */
export const isCurrent = (s: AgentSession) => s.place !== null || s.process !== null

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** A posted event, checked, or null if it isn't one */
export function parseEvent(o: unknown): RegistryEvent | null {
  if (!isRecord(o)) return null
  const terminal = str(o.terminal)
  const label = str(o.label)
  if (o.kind === "shell") {
    return terminal && label ? { kind: "shell", terminal, label } : null
  }
  const session = str(o.session)
  const { event, harness } = o
  if (
    o.kind !== "hook" ||
    !session ||
    !isOneOf(HOOK_EVENTS, event) ||
    !isOneOf(HARNESSES, harness)
  ) {
    return null
  }
  return {
    kind: "hook",
    event,
    harness,
    session,
    terminal,
    label: label ?? "",
    cwd: str(o.cwd),
    prompt: str(o.prompt) ?? undefined,
    transcript: str(o.transcript) ?? undefined,
  }
}

/** Every terminal in the tree. null when there are no windows, which means
 * Rex isn't running (or ah can't reach it), not that every
 * terminal closed. */
const liveTerminals = (snapshot: Snapshot | null): Set<string> | null =>
  snapshot?.windows.length
    ? new Set(
        snapshot.windows.flatMap((w) =>
          w.tabs.flatMap((t) => t.terminals.map((x) => x.id)),
        ),
      )
    : null

type Listener = (registry: Registry, terminals: string[]) => void

export class SessionsApp {
  readonly registry: Registry
  #snapshot: Snapshot | null = null
  #listeners: Listener[] = []
  /** Terminals named by an event in the last few seconds, which the
   * snapshot may not have caught up with, so pruning leaves them alone */
  #recent = new Map<string, number>()
  #saveTimer: NodeJS.Timeout | null = null
  #file: string
  #log: string

  constructor(registry: Registry, file = registryFile()) {
    this.registry = registry
    this.#file = file
    this.#log = join(dirname(file), "registry-events.jsonl")
    mkdirSync(dirname(file), { recursive: true })
  }

  /** With the registry as last saved */
  static load(file = registryFile()): SessionsApp {
    return new SessionsApp(loadRegistry(file) ?? emptyRegistry(), file)
  }

  /** Hear about every change, with the terminals whose tabs it touched */
  subscribe(listener: Listener) {
    this.#listeners.push(listener)
  }

  onSnapshot(snapshot: Snapshot) {
    this.#snapshot = snapshot
    const now = Date.now()
    for (const [t, at] of this.#recent) if (now - at > 10_000) this.#recent.delete(t)
    const live = liveTerminals(snapshot)
    if (prune(this.registry, live, new Set(this.#recent.keys()))) this.#changed([])
  }

  /** Apply one event; what the event endpoint does */
  receive(event: RegistryEvent) {
    try {
      this.#apply(this.#locate(event))
    } catch (e) {
      console.error(`ah: couldn't apply an event: ${e}`)
    }
  }

  /** A Codex or opencode event without a terminal (it came from their
   * shared server) gets the one its TUI is in, and that terminal's shell
   * label */
  #locate(event: RegistryEvent): RegistryEvent {
    if (event.kind !== "hook" || event.terminal) return event
    if (event.harness !== "codex" && event.harness !== "opencode") return event
    const terminal = pickTerminal(
      event.cwd,
      readTuis(event.harness),
      this.registry.sessions.get(event.session)?.terminalId ?? null,
      focusedTerminal(this.#snapshot),
      liveTerminals(this.#snapshot),
    )
    if (!terminal) return event
    return {
      ...event,
      terminal,
      label: this.registry.shellLabels.get(terminal) ?? event.label,
    }
  }

  #apply(event: RegistryEvent) {
    this.#write("event", event)
    const { terminals, summarize } = apply(this.registry, event)
    for (const t of terminals) this.#recent.set(t, Date.now())
    this.#changed(terminals)
    if (summarize) {
      this.#summarize(summarize).catch((e) => console.error(`ah: couldn't summarize: ${e}`))
    }
  }

  /** A summary from the harness itself, e.g. opencode's session title */
  retitle(session: string, title: string) {
    const record = this.registry.sessions.get(session)
    if (!record || record.summary === title) return
    this.#write("summary", { session, sequence: record.promptSequence, summary: title })
    record.summary = title
    record.summarySequence = record.promptSequence
    this.#changed(record.terminalId ? [record.terminalId] : [])
  }

  async #summarize(job: SummaryJob) {
    const payload = await buildSummaryPayload(job.transcript, job.priorSummary, job.prompt)
    const fields = { session: job.session, sequence: job.sequence }
    if (!payload)
      return this.#write("summary-skipped", { ...fields, reason: "no messages" })
    const summary = await generateSummary(payload)
    if (!summary) return this.#write("summary-skipped", { ...fields, reason: "empty" })
    this.#write("summary", { ...fields, summary })
    const terminal = applySummary(this.registry, job.session, job.sequence, summary)
    if (terminal) this.#changed([terminal])
  }

  #changed(terminals: string[]) {
    this.#scheduleSave()
    for (const l of this.#listeners) l(this.registry, terminals)
  }

  #scheduleSave() {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null
      this.#save()
    }, 200)
  }

  #save() {
    try {
      saveRegistry(this.registry, this.#file)
    } catch (e) {
      console.error(`ah: couldn't save the session registry: ${e}`)
    }
  }

  /** `log` is the line's kind, apart from the fields, since a hook event
   * has an `event` of its own */
  #write(log: string, fields: object) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), log, ...fields })
    try {
      appendFileSync(this.#log, line + "\n")
    } catch {
      // only for debugging
    }
  }

  /** `rest` is the path after /app/sessions/ */
  async handle(req: Request, rest: string): Promise<Response> {
    if (rest === "event" && req.method === "POST") {
      const event = parseEvent(await req.json().catch(() => null))
      if (!event) return new Response("bad event", { status: 400 })
      this.receive(event)
      return new Response(null, { status: 204 })
    }
    if (rest !== "") return new Response("not found", { status: 404 })
    const all = new URL(req.url).searchParams.has("all")
    const sessions = listSessions(
      this.registry,
      await readClaudeProcesses(),
      this.#snapshot,
    )
    return Response.json(all ? sessions : sessions.filter(isCurrent))
  }
}
