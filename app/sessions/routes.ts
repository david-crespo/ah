// The sessions app's routes, under /app/sessions/: GET the agents as JSON,
// from the registry and Rex's latest snapshot (`?all` includes ones
// that aren't in a terminal or running any more), POST `event` for the
// hooks (cli.ts) to report into the registry, which answers with the
// file in the dashboard for the agent's tab, POST `file` and `clear-file` to
// set, read, or clear those, and GET `files` to list them.
//
// The app is also where pages find the agents they're bound to
// (host/files/files.ts): `open` and Claude's hooks say where an agent can be
// reached, which is kept in memory only, since Claude's has its token.
//
// The app owns the registry. Each event is applied synchronously, then the
// registry is saved (debounced) and listeners hear which terminals changed;
// a prompt's summary runs after, and is applied the same way when it's
// ready. Events and summary outcomes are logged to registry-events.jsonl for
// working out afterwards why a title was what it was.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isString } from "../../host/guards.ts"
import type { AgentDirectory } from "../../host/files/files.ts"
import type { Snapshot } from "../../host/rex.ts"
import { parseSession, type Session, sessionAlive } from "../../host/session.ts"
import { focusedTerminal, pickTerminal, readTuis } from "./tuis.ts"
import {
  type AgentRef,
  agentId,
  apply,
  applySummary,
  clearFile,
  emptyRegistry,
  HARNESSES,
  HOOK_EVENTS,
  loadRegistry,
  parseAgentRef,
  prune,
  type Registry,
  type RegistryEvent,
  registryFile,
  saveRegistry,
  setFile,
  type SummaryJob,
} from "./registry.ts"
import { type AgentView, listAgents, readClaudeProcesses } from "./sessions.ts"
import { buildSummaryPayload, generateSummary } from "./summary.ts"

/** In a terminal that still exists, or running */
export const isCurrent = (a: AgentView) => a.place !== null || a.process !== null

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
    process: str(o.process),
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

const liveTabs = (snapshot: Snapshot | null): Set<string> | null =>
  snapshot?.windows.length
    ? new Set(snapshot.windows.flatMap((w) => w.tabs.map((t) => t.id)))
    : null

/** The tab a terminal is in */
const tabOf = (snapshot: Snapshot | null, terminal: string) =>
  snapshot?.windows
    .flatMap((w) => w.tabs)
    .find((t) => t.terminals.some((x) => x.id === terminal)) ?? null

/** A file in the dashboard, and where: `tab` is its tab's name, null for an
 * agent outside Rex */
export interface HomeFile {
  home: string
  tab: string | null
  path: string
}

type Listener = (registry: Registry, terminals: string[]) => void

export class SessionsApp implements AgentDirectory {
  readonly registry: Registry
  /** By agent id: where it can be reached, from the last `open` or hook
   * that said. In memory only, since Claude's has its token. */
  #addresses = new Map<string, Session>()
  /** Each terminal's tab, kept after the terminal closes for as long as the
   * tab is open, so a closed pane's comments find the rest of its tab */
  #tabs = new Map<string, string>()
  #snapshot: Snapshot | null = null
  #firstSnapshot: Promise<void>
  #gotSnapshot = () => {}
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
    this.#firstSnapshot = new Promise((resolve) => (this.#gotSnapshot = resolve))
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
    this.#gotSnapshot()
    const now = Date.now()
    for (const [t, at] of this.#recent) if (now - at > 10_000) this.#recent.delete(t)
    const terminals = liveTerminals(snapshot)
    const tabs = liveTabs(snapshot)
    for (const tab of snapshot.windows.flatMap((w) => w.tabs))
      for (const t of tab.terminals) this.#tabs.set(t.id, tab.id)
    if (tabs) for (const [t, tab] of this.#tabs) if (!tabs.has(tab)) this.#tabs.delete(t)
    const live = terminals && tabs && { terminals, tabs }
    if (prune(this.registry, live, new Set(this.#recent.keys()))) this.#changed([])
  }

  /** Apply one event; what the event endpoint does. Returns the agent it
   * was for, if any. `address` is where the agent says it can be reached. */
  receive(event: RegistryEvent, address: Session | null = null): string | null {
    try {
      return this.#apply(this.#locate(event), address)
    } catch (e) {
      console.error(`ah: couldn't apply an event: ${e}`)
      return null
    }
  }

  bind(agent: AgentRef | string, session: Session | null): string | null {
    const id = typeof agent === "string" ? agent : agentId(this.registry, agent)
    if (id && session) this.#addresses.set(id, session)
    return id
  }

  /** Codex and opencode are reached by their session, so an agent's is
   * always the one it's in now, even after Codex's /new. Claude is reached
   * by its process's inbox socket, which lasts through /clear; a new process
   * in the pane reports its own from its hooks. */
  address(agent: string): Session | null {
    const known = this.#addresses.get(agent) ?? null
    const record = this.registry.agents.get(agent)
    if (!record) return known
    switch (record.harness) {
      case "claude":
        return known?.harness === "claude" ? known : null
      case "codex":
        // The pid is for telling whether it's alive; a new session's isn't
        // known, so it's taken to be until a post fails
        return known?.harness === "codex" && known.thread === record.session
          ? known
          : { harness: "codex", thread: record.session, pid: null }
      case "opencode":
        return { harness: "opencode", id: record.session }
      case "pi":
        return null
    }
  }

  /** The live agent in `agent`'s tab that last did something, other than
   * it */
  standIn(agent: string): Session | null {
    // In Rex an agent's id is its pane's, which may have closed
    const block = this.registry.agents.get(agent)?.block ?? agent
    const tabId = this.#tabs.get(block)
    const tab = this.#snapshot?.windows.flatMap((w) => w.tabs).find((t) => t.id === tabId)
    if (!tab) return null
    let best: { at: number; address: Session } | null = null
    for (const { id: terminal } of tab.terminals) {
      const other = this.registry.agents.get(terminal)
      if (terminal === agent || !other?.shown) continue
      const address = this.address(terminal)
      if (sessionAlive(address) && (!best || other.updatedAt > best.at))
        best = { at: other.updatedAt, address: address! }
    }
    return best?.address ?? null
  }

  /** Where the agent `ref` names keeps its file: the tab its pane is in,
   * or outside Rex, the agent itself. null for a pane the snapshot doesn't
   * have. */
  async homeOf(ref: AgentRef): Promise<string | null> {
    const id = agentId(this.registry, ref)
    const block = ref.terminal ?? (id && this.registry.agents.get(id)?.block) ?? null
    if (!block) return id
    // Right after the server starts, Rex's first snapshot may still be on
    // its way. In Rex, so it won't be long.
    await Promise.race([this.#firstSnapshot, new Promise((r) => setTimeout(r, 500))])
    return tabOf(this.#snapshot, block)?.id ?? null
  }

  /** Set (or with null, clear) the file for `home`. Returns the one it had. */
  setFile(home: string, path: string | null): string | null {
    const previous = setFile(this.registry, home, path)
    this.#write("file", { home, file: path })
    this.#changed([])
    return previous
  }

  /** Every file in the dashboard */
  files(): HomeFile[] {
    const tabs = new Map(
      (this.#snapshot?.windows ?? []).flatMap((w) => w.tabs.map((t) => [t.id, t.name])),
    )
    return [...this.registry.files].map(([home, f]) => ({
      home,
      tab: tabs.get(home) ?? null,
      path: f.path,
    }))
  }

  /** Clear `path` from whichever homes have it. Returns how many did. */
  clearFile(path: string): number {
    const cleared = clearFile(this.registry, path)
    if (cleared) this.#changed([])
    return cleared
  }

  /** A Codex or opencode event without a terminal (it came from their
   * shared server) gets the one its TUI is in, and that terminal's shell
   * label */
  #locate(event: RegistryEvent): RegistryEvent {
    if (event.kind !== "hook" || event.terminal) return event
    if (event.harness !== "codex" && event.harness !== "opencode") return event
    const known = agentId(this.registry, { ...event, terminal: null, process: null })
    const terminal = pickTerminal(
      event.cwd,
      readTuis(event.harness),
      (known && this.registry.agents.get(known)?.block) || null,
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

  #apply(event: RegistryEvent, address: Session | null): string | null {
    this.#write("event", event)
    const { agent, terminals, summarize } = apply(this.registry, event)
    // Before listeners hear of it, so a page bound to the agent can reach it
    if (agent && address) this.#addresses.set(agent, address)
    // Another harness in the pane: the last one's address is no use
    else if (
      agent &&
      event.kind === "hook" &&
      this.#addresses.get(agent)?.harness !== event.harness
    )
      this.#addresses.delete(agent)
    for (const t of terminals) this.#recent.set(t, Date.now())
    this.#changed(terminals)
    if (summarize) {
      this.#summarize(summarize).catch((e) => console.error(`ah: couldn't summarize: ${e}`))
    }
    return agent
  }

  /** A summary from the harness itself, e.g. opencode's session title */
  retitle(session: string, title: string) {
    const id = agentId(this.registry, { harness: "opencode", session, terminal: null })
    const record = id ? this.registry.agents.get(id) : undefined
    if (!record || record.session !== session || record.summary === title) return
    this.#write("summary", { agent: id, sequence: record.promptSequence, summary: title })
    record.summary = title
    record.summarySequence = record.promptSequence
    this.#changed(record.block ? [record.block] : [])
  }

  async #summarize(job: SummaryJob) {
    const payload = await buildSummaryPayload(job.transcript, job.priorSummary, job.prompt)
    const fields = { agent: job.agent, session: job.session, sequence: job.sequence }
    if (!payload)
      return this.#write("summary-skipped", { ...fields, reason: "no messages" })
    const summary = await generateSummary(payload)
    if (!summary) return this.#write("summary-skipped", { ...fields, reason: "empty" })
    this.#write("summary", { ...fields, summary })
    const terminal = applySummary(this.registry, job, summary)
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
      const body: unknown = await req.json().catch(() => null)
      const event = parseEvent(body)
      if (!event) return new Response("bad event", { status: 400 })
      // Apart from the event, which is logged, since it has Claude's token
      const address = isRecord(body) ? parseSession(body.address) : null
      const agent = this.receive(event, address)
      // Only a starting session needs it
      if (!agent || event.kind !== "hook" || event.event !== "SessionStart")
        return Response.json({ file: null })
      const home = await this.homeOf(event)
      return Response.json({ file: (home && this.registry.files.get(home)?.path) || null })
    }
    if (rest === "file" && req.method === "POST") {
      // { agent, file }: set it, or clear it with null; without `file`, read it
      const body: unknown = await req.json().catch(() => null)
      const ref = isRecord(body) ? parseAgentRef(body.agent) : null
      if (!isRecord(body) || !ref) return new Response("bad agent", { status: 400 })
      const home = await this.homeOf(ref)
      if (!home) return new Response("this pane isn't in Rex's tabs", { status: 409 })
      if (!("file" in body))
        return Response.json({ file: this.registry.files.get(home)?.path ?? null })
      if (body.file !== null && !isString(body.file))
        return new Response("bad file", { status: 400 })
      const previous = this.setFile(home, body.file)
      return Response.json({ file: body.file, previous })
    }
    if (rest === "files" && req.method === "GET") return Response.json(this.files())
    if (rest === "clear-file" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null)
      if (!isRecord(body) || !isString(body.file))
        return new Response("bad file", { status: 400 })
      return Response.json({ cleared: this.clearFile(body.file) })
    }
    if (rest !== "") return new Response("not found", { status: 404 })
    const all = new URL(req.url).searchParams.has("all")
    const agents = listAgents(this.registry, await readClaudeProcesses(), this.#snapshot)
    return Response.json(all ? agents : agents.filter(isCurrent))
  }
}
