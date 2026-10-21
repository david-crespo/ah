// The core: the agents, and where requests for them go. Its routes, under
// /core/: GET the agents as JSON,
// from the registry and Rex's latest state (`?all` includes ones
// that aren't in a block or running any more), POST `event` for the
// hooks (hook.ts) to report into the registry, which answers with what the
// hook should tell the agent (notices.ts), POST `current-tracker` to set,
// read, or clear an agent's workspace's current tracker, GET `trackers`
// for one workspace's,
// and POST `tracker-status` to park or finish one (trackers.ts). The CLI's
// client for the tracker routes is tracker_api.ts.
//
// It's also where pages find the agents they're bound to
// (subjects/files/files.ts): `open` and Claude's hooks say where an agent can be
// reached, which is kept in memory only, since Claude's has its token.
//
// The core owns the registry. Each event is applied synchronously, then the
// registry is saved (debounced) and listeners hear which blocks changed;
// a prompt's summary runs after, and is applied the same way when it's
// ready. Events and summary outcomes are logged to registry-events.jsonl for
// working out afterwards why a title was what it was.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isString } from "../platform/guards.ts"
import type { AgentDirectory } from "../subjects/files/files.ts"
import {
  addressAlive,
  claudeSocket,
  parseAddress,
  parseAgentRef,
} from "../platform/session.ts"
import {
  type Address,
  type AgentId,
  type AgentRef,
  HARNESSES,
  type RexState,
} from "./model.ts"
import { Notices, type Showing, startContext } from "./notices.ts"
import { Trackers } from "./trackers.ts"
import { focusedBlock, pickBlock, readTuis } from "./tuis.ts"
import { rootFinder } from "./workspace.ts"
import {
  agentId,
  apply,
  applySummary,
  blockOf,
  emptyRegistry,
  HOOK_EVENTS,
  loadRegistry,
  prune,
  type Registry,
  type RegistryEvent,
  registryFile,
  saveRegistry,
  type SummaryJob,
} from "./registry.ts"
import { type AgentView, listAgents, readClaudeProcesses } from "./agent_view.ts"
import { buildSummaryPayload, generateSummary } from "./summary.ts"

/** In a block that still exists, or running */
export const isCurrent = (a: AgentView) => a.tab !== null || a.process !== null

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** A posted event, checked, or null if it isn't one */
export function parseEvent(o: unknown): RegistryEvent | null {
  if (!isRecord(o)) return null
  const block = str(o.block)
  const label = str(o.label)
  if (o.kind === "shell") {
    return block && label ? { kind: "shell", block, label } : null
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
    block,
    process: str(o.process),
    label: label ?? "",
    cwd: str(o.cwd),
    prompt: str(o.prompt) ?? undefined,
    transcript: str(o.transcript) ?? undefined,
  }
}

/** Every block in the tree. null when there are no windows, which means
 * Rex isn't running (or ah can't reach it), not that every
 * block closed. */
const liveBlocks = (rex: RexState | null): Set<string> | null =>
  rex?.sessions.length
    ? new Set(rex.sessions.flatMap((s) => s.tabs.flatMap((t) => t.blocks.map((x) => x.id))))
    : null

const liveTabs = (rex: RexState | null): Set<string> | null =>
  rex?.sessions.length
    ? new Set(rex.sessions.flatMap((s) => s.tabs.map((t) => t.id)))
    : null

/** The tab a block is in */
const tabOf = (rex: RexState | null, block: string) =>
  rex?.sessions.flatMap((s) => s.tabs).find((t) => t.blocks.some((x) => x.id === block)) ??
  null

type Listener = (registry: Registry, blocks: string[]) => void

export class Core implements AgentDirectory {
  readonly registry: Registry
  readonly trackers: Trackers
  /** By agent id: where it can be reached, from the last `open` or hook
   * that said. In memory only, since Claude's has its token. */
  #addresses = new Map<string, Address>()
  /** Each block's tab, kept after the block closes for as long as the
   * tab is open, so a closed pane's comments find the rest of its tab */
  #tabs = new Map<string, string>()
  #rex: RexState | null = null
  #firstRex: Promise<void>
  #gotRex = () => {}
  #listeners: Listener[] = []
  #notices = new Notices()
  /** What windows show, from the backends (watchShowing) */
  #showing: () => Showing = () => ({ files: [], dashboard: false })
  /** Blocks named by an event in the last few seconds, which the
   * RexState may not have caught up with, so pruning leaves them alone */
  #recent = new Map<string, number>()
  #saveTimer: NodeJS.Timeout | null = null
  #file: string
  #log: string

  constructor(registry: Registry, file = registryFile()) {
    this.registry = registry
    this.trackers = new Trackers({
      registry,
      rex: () => this.#rex,
      changed: (change) => {
        this.#write("trackers", change)
        this.#changed([])
      },
    })
    this.#file = file
    this.#log = join(dirname(file), "registry-events.jsonl")
    mkdirSync(dirname(file), { recursive: true })
    this.#firstRex = new Promise((resolve) => (this.#gotRex = resolve))
  }

  /** With the registry as last saved */
  static load(file = registryFile()): Core {
    const core = new Core(loadRegistry(file) ?? emptyRegistry(), file)
    core.trackers.prune()
    return core
  }

  /** Where to find what windows show, for telling agents when a file they
   * opened stops showing */
  watchShowing(showing: () => Showing) {
    this.#showing = showing
  }

  /** Hear about every change, with the blocks whose tabs it touched */
  subscribe(listener: Listener) {
    this.#listeners.push(listener)
  }

  onRex(rex: RexState) {
    this.#rex = rex
    this.#gotRex()
    const now = Date.now()
    for (const [t, at] of this.#recent) if (now - at > 10_000) this.#recent.delete(t)
    const blocks = liveBlocks(rex)
    const tabs = liveTabs(rex)
    for (const tab of rex.sessions.flatMap((s) => s.tabs))
      for (const t of tab.blocks) this.#tabs.set(t.id, tab.id)
    if (tabs) for (const [t, tab] of this.#tabs) if (!tabs.has(tab)) this.#tabs.delete(t)
    if (prune(this.registry, blocks, new Set(this.#recent.keys()))) this.#changed([])
  }

  /** Apply one event; what the event endpoint does. Returns the agent it
   * was for, if any. `address` is where the agent says it can be reached. */
  receive(event: RegistryEvent, address: Address | null = null): string | null {
    try {
      return this.#apply(this.#locate(event), address)
    } catch (e) {
      console.error(`ah: couldn't apply an event: ${e}`)
      return null
    }
  }

  agentId(ref: AgentRef): AgentId | null {
    return agentId(this.registry, ref)
  }

  bind(agent: AgentId, address: Address | null) {
    if (address) this.#addresses.set(agent, address)
  }

  /** Codex and opencode are reached by their session, so an agent's is
   * always the one it's in now, even after Codex's /new. Claude is reached
   * by its process's inbox socket, which lasts through /clear; a new process
   * in the pane reports its own from its hooks. Until it has, or after the
   * server restarts, the socket comes from Claude's record of the session. */
  address(agent: string): Address | null {
    const known = this.#addresses.get(agent) ?? null
    const record = this.registry.agents.get(agent)
    if (!record) return known
    switch (record.harness) {
      case "claude": {
        const own = known?.harness === "claude" ? known : null
        if (addressAlive(own)) return own
        const socket = claudeSocket(record.session)
        return socket ? { harness: "claude", socket } : own
      }
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
  standIn(agent: string): Address | null {
    // In Rex an agent's id is its pane's, which may have closed
    const record = this.registry.agents.get(agent)
    const block = (record && blockOf(record)) ?? agent
    const tabId = this.#tabs.get(block)
    const tab = this.#rex?.sessions.flatMap((s) => s.tabs).find((t) => t.id === tabId)
    if (!tab) return null
    let best: { at: number; address: Address } | null = null
    for (const { id } of tab.blocks) {
      const other = this.registry.agents.get(id)
      if (id === agent || !other?.shown) continue
      const address = this.address(id)
      if (addressAlive(address) && (!best || other.updatedAt > best.at))
        best = { at: other.updatedAt, address: address! }
    }
    return best?.address ?? null
  }

  /** Where the agent `ref` names is, for finding its workspace: the tab
   * its pane is in, or outside Rex, the agent's id. null for a pane the
   * RexState doesn't have. */
  async homeOf(ref: AgentRef): Promise<string | null> {
    const id = agentId(this.registry, ref)
    const record = id ? this.registry.agents.get(id) : undefined
    const block = ref.block ?? (record && blockOf(record)) ?? null
    if (!block) return id
    // Right after the server starts, Rex's first RexState may still be on
    // its way. In Rex, so it won't be long.
    await Promise.race([this.#firstRex, new Promise((r) => setTimeout(r, 500))])
    return tabOf(this.#rex, block)?.id ?? null
  }

  async #workspaceOf(ref: AgentRef): Promise<string | null> {
    const home = await this.homeOf(ref)
    return home && this.trackers.workspaceOf(home)
  }

  /** What the agent's hook prints: a starting session's trackers, or on a
   * prompt, what changed since it was last told (notices.ts) */
  async #context(agent: string, event: RegistryEvent): Promise<string | null> {
    if (event.kind !== "hook") return null
    if (event.event !== "SessionStart" && event.event !== "UserPromptSubmit") return null
    const root = await this.#workspaceOf(event)
    const current = root && this.trackers.currentPath(root)
    if (event.event === "SessionStart") {
      this.#notices.start(agent, current, this.#showing())
      if (!root) return null
      const active = this.trackers
        .get(root)
        .active.flatMap((t) => ("path" in t.subject ? [t.subject.path] : []))
      return startContext(current, active)
    }
    const lines = this.#notices.since(agent, current, this.#showing())
    return lines.length ? lines.join("\n") : null
  }

  /** A Codex or opencode event without a block (it came from their
   * shared server) gets the one its TUI is in, and that block's shell
   * label */
  #locate(event: RegistryEvent): RegistryEvent {
    if (event.kind !== "hook" || event.block) return event
    if (event.harness !== "codex" && event.harness !== "opencode") return event
    const known = agentId(this.registry, { ...event, block: null, process: null })
    const record = known ? this.registry.agents.get(known) : undefined
    const block = pickBlock(
      event.cwd,
      readTuis(event.harness),
      (record && blockOf(record)) || null,
      focusedBlock(this.#rex),
      liveBlocks(this.#rex),
    )
    if (!block) return event
    return {
      ...event,
      block,
      label: this.registry.shellLabels.get(block) ?? event.label,
    }
  }

  #apply(event: RegistryEvent, address: Address | null): string | null {
    this.#write("event", event)
    const { agent, blocks, summarize } = apply(this.registry, event)
    // Before listeners hear of it, so a page bound to the agent can reach it
    if (agent && address) this.#addresses.set(agent, address)
    // Another harness in the pane: the last one's address is no use
    else if (
      agent &&
      event.kind === "hook" &&
      this.#addresses.get(agent)?.harness !== event.harness
    )
      this.#addresses.delete(agent)
    for (const t of blocks) this.#recent.set(t, Date.now())
    this.#changed(blocks)
    if (summarize) {
      this.#summarize(summarize).catch((e) => console.error(`ah: couldn't summarize: ${e}`))
    }
    return agent
  }

  /** A summary from the harness itself, e.g. opencode's session title */
  retitle(session: string, title: string) {
    const id = agentId(this.registry, {
      harness: "opencode",
      session,
      block: null,
      process: null,
    })
    const record = id ? this.registry.agents.get(id) : undefined
    if (!record || record.session !== session || record.summary === title) return
    this.#write("summary", { agent: id, sequence: record.promptSequence, summary: title })
    record.summary = title
    record.summarySequence = record.promptSequence
    const block = blockOf(record)
    this.#changed(block ? [block] : [])
  }

  async #summarize(job: SummaryJob) {
    const payload = await buildSummaryPayload(job.transcript, job.priorSummary, job.prompt)
    const fields = { agent: job.agent, session: job.session, sequence: job.sequence }
    if (!payload)
      return this.#write("summary-skipped", { ...fields, reason: "no messages" })
    const summary = await generateSummary(payload)
    if (!summary) return this.#write("summary-skipped", { ...fields, reason: "empty" })
    this.#write("summary", { ...fields, summary })
    const block = applySummary(this.registry, job, summary)
    if (block) this.#changed([block])
  }

  #changed(blocks: string[]) {
    this.#scheduleSave()
    for (const l of this.#listeners) l(this.registry, blocks)
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
      console.error(`ah: couldn't save the registry: ${e}`)
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

  /** `rest` is the path after /core/ */
  async handle(req: Request, rest: string): Promise<Response> {
    if (rest === "event" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null)
      const event = parseEvent(body)
      if (!event) return new Response("bad event", { status: 400 })
      // Apart from the event, which is logged, since it has Claude's token
      const address = isRecord(body) ? parseAddress(body.address) : null
      const agent = this.receive(event, address)
      return Response.json({ context: agent && (await this.#context(agent, event)) })
    }
    if (rest === "current-tracker" && req.method === "POST") {
      // { agent, path }: make it current; without `path`, read it
      const body: unknown = await req.json().catch(() => null)
      const ref = isRecord(body) ? parseAgentRef(body.agent) : null
      if (!isRecord(body) || !ref) return new Response("bad agent", { status: 400 })
      const home = await this.homeOf(ref)
      if (!home) return new Response("this pane isn't in Rex's tabs", { status: 409 })
      const root = this.trackers.workspaceOf(home)
      if (!root) return new Response("this agent has no directory", { status: 409 })
      if (!("path" in body)) return Response.json({ path: this.trackers.currentPath(root) })
      if (!isString(body.path) || !body.path)
        return new Response("bad path", { status: 400 })
      this.trackers.add(root, body.path)
      const agent = agentId(this.registry, ref)
      if (agent) this.#notices.madeCurrent(agent, body.path)
      return Response.json({ path: body.path })
    }
    if (rest === "tracker-status" && req.method === "POST") {
      // { path, status }: park or finish a tracker
      const body: unknown = await req.json().catch(() => null)
      if (!isRecord(body) || !isString(body.path) || !body.path.startsWith("/"))
        return new Response("bad path", { status: 400 })
      if (!isOneOf(["parked", "done"] as const, body.status))
        return new Response("bad status", { status: 400 })
      if (!this.trackers.setStatus(body.path, body.status))
        return new Response(`not a tracker: ${body.path}`, { status: 404 })
      return Response.json({ path: body.path })
    }
    if (rest === "trackers" && req.method === "GET") {
      // ?dir=: the trackers of the workspace it's in
      const dir = new URL(req.url).searchParams.get("dir")
      if (!dir?.startsWith("/")) return new Response("bad dir", { status: 400 })
      const root = rootFinder()(dir) ?? dir
      return Response.json({
        root,
        ...this.trackers.get(root),
        done: this.trackers.done(root),
      })
    }
    if (rest !== "") return new Response("not found", { status: 404 })
    const all = new URL(req.url).searchParams.has("all")
    const processes = await readClaudeProcesses()
    const agents = listAgents(this.registry, processes, this.#rex)
    return Response.json(all ? agents : agents.filter(isCurrent))
  }
}
