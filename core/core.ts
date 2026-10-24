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
// It's also where files' requests find their agents (subjects/files/files.ts):
// which agent each file is bound to, kept in the registry, and where that
// agent can be reached now, which `open` and Claude's hooks say. And which
// files hold requests no agent took, to send when one turns up. POST `send`
// takes a plain message from a tool in a Rex pane (`ah message send`): the
// user's editor or a diff review, for the agent in its tab, and keeps it in
// the pane's outbox until one is there.
//
// The core owns the registry. Each event is applied synchronously, then the
// registry is saved (debounced) and listeners hear which blocks changed;
// a prompt's summary runs after, and is applied the same way when it's
// ready. Events and summary outcomes are logged to registry-events.jsonl for
// working out afterwards why a title was what it was.

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isString, str } from "../platform/guards.ts"
import type { AgentDirectory } from "../subjects/files/files.ts"
import {
  addressAlive,
  claudeSocket,
  parseAddress,
  parseAgentRef,
  postTo,
} from "../platform/session.ts"
import {
  type Address,
  type AgentId,
  type AgentRef,
  type BlockId,
  HARNESSES,
  type NearbyAgent,
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

/** Ahead of every plain message `ah message send` relays */
export const RELAYED =
  "From the user, through ah: treat it as typed here and answer in the terminal, not with SendMessage."

export class Core implements AgentDirectory {
  readonly registry: Registry
  readonly trackers: Trackers
  /** By agent id: where it can be reached, from the last `open` or hook
   * that said */
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
  /** By pane: the flush of its outbox under way, so its messages go one at
   * a time, in order */
  #flushing = new Map<BlockId, Promise<void>>()
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
    // Files that are gone take no more requests
    const { bindings, held } = core.registry
    for (const path of bindings.keys()) if (!existsSync(path)) bindings.delete(path)
    for (const path of held) if (!existsSync(path)) held.delete(path)
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

  bindFile(path: string, agent: AgentId) {
    if (this.registry.bindings.get(path) === agent) return
    this.registry.bindings.set(path, agent)
    this.#scheduleSave()
  }

  binding(path: string): AgentId | null {
    return this.registry.bindings.get(path) ?? null
  }

  route(path: string, target: AgentId | null = null): Address | null {
    const agent = target ?? this.binding(path)
    return agent ? this.reach(agent) : null
  }

  /** Where to post to `agent` now: its own address while that's alive, else
   * its stand-in's */
  reach(agent: AgentId): Address | null {
    const own = this.address(agent)
    return addressAlive(own) ? own : (this.standIn(agent) ?? own)
  }

  hold(path: string, held: boolean) {
    if (this.registry.held.has(path) === held) return
    if (held) this.registry.held.add(path)
    else this.registry.held.delete(path)
    this.#scheduleSave()
  }

  /** The files whose threads hold requests, to send when agents come and go */
  get held(): string[] {
    return [...this.registry.held]
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
    const live = this.#liveInTab((record && blockOf(record)) ?? agent, agent)
    const updated = (id: AgentId) => this.registry.agents.get(id)!.updatedAt
    const standIn = live.reduce<AgentId | null>(
      (best, id) => (best && updated(best) >= updated(id) ? best : id),
      null,
    )
    return standIn ? this.address(standIn) : null
  }

  /** The live agents in `block`'s tab, in its layout order, for a file
   * opened from a shell there to pick from. That includes the agent in
   * `block` itself, for a tool the agent started there. */
  agentsNear(block: BlockId): AgentId[] {
    return this.#liveInTab(block, null)
  }

  /** Where a shell's messages and files go without an agent named: its
   * pick, while that's live in its tab; else the agent in its own pane, for
   * a tool that agent started; else the tab's only agent */
  targetNear(block: BlockId, near = this.agentsNear(block)): AgentId | null {
    const picked = this.registry.picks.get(block)
    if (picked && near.includes(picked)) return picked
    if (near.includes(block)) return block
    return near.length === 1 ? near[0] : null
  }

  pick(block: BlockId, agent: AgentId) {
    if (this.registry.picks.get(block) === agent) return
    this.registry.picks.set(block, agent)
    this.#scheduleSave()
  }

  /** A message from a tool in pane `block` to the agent it sends to
   * (targetNear), after any it sent before that are still waiting. Whatever
   * no agent takes waits in the pane's outbox for the next flush. */
  async send(block: BlockId, text: string): Promise<"sent" | "held"> {
    const waiting = this.registry.outbox.get(block) ?? []
    waiting.push(`${RELAYED}\n\n${text}`)
    this.registry.outbox.set(block, waiting)
    this.#scheduleSave()
    await this.#flush(block)
    return this.registry.outbox.has(block) ? "held" : "sent"
  }

  /** Send every pane's waiting messages to the agent it sends to, if one is
   * there now: for when agents come and go */
  async flush() {
    await Promise.all([...this.registry.outbox.keys()].map((block) => this.#flush(block)))
  }

  #flush(block: BlockId): Promise<void> {
    const flushing = (this.#flushing.get(block) ?? Promise.resolve())
      .then(() => this.#drain(block))
      .finally(() => {
        if (this.#flushing.get(block) === flushing) this.#flushing.delete(block)
      })
    this.#flushing.set(block, flushing)
    return flushing
  }

  async #drain(block: BlockId) {
    const target = this.targetNear(block)
    const address = target && this.reach(target)
    const waiting = this.registry.outbox.get(block)
    if (!address || !waiting) return
    while (waiting.length) {
      try {
        await postTo(address, waiting[0])
      } catch (e) {
        console.error(`ah: couldn't post to ${target}; its messages wait:`, e)
        return
      }
      waiting.shift()
      this.#scheduleSave()
    }
    this.registry.outbox.delete(block)
  }

  /** The live agents in `block`'s tab other than `except`, in its layout
   * order */
  #liveInTab(block: BlockId, except: AgentId | null): AgentId[] {
    const tabId = this.#tabs.get(block)
    const tab = this.#rex?.sessions.flatMap((s) => s.tabs).find((t) => t.id === tabId)
    if (!tab) return []
    return tab.blocks
      .map((b) => b.id)
      .filter(
        (id) =>
          id !== except &&
          this.registry.agents.get(id)?.shown &&
          addressAlive(this.address(id)),
      )
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
      // Apart from the event, which is logged
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
    if (rest === "agents-near" && req.method === "GET") {
      // ?block=: the live agents in its tab, in its layout order
      const block = new URL(req.url).searchParams.get("block")
      if (!block) return new Response("bad block", { status: 400 })
      // As in homeOf: right after a start, Rex's first RexState may be on its way
      await Promise.race([this.#firstRex, new Promise((r) => setTimeout(r, 500))])
      const near = this.agentsNear(block)
      const target = this.targetNear(block, near)
      return Response.json(
        near.map((id): NearbyAgent => {
          const { harness, label, summary, busy } = this.registry.agents.get(id)!
          return { id, harness, label, summary, busy, target: id === target }
        }),
      )
    }
    if (rest === "pick" && req.method === "POST") {
      // { block, agent }: the shell in `block` picks `agent` in its tab
      const body: unknown = await req.json().catch(() => null)
      if (!isRecord(body) || !isString(body.block) || !isString(body.agent))
        return new Response("bad pick", { status: 400 })
      if (!this.agentsNear(body.block).includes(body.agent))
        return new Response(`${body.agent} isn't a live agent in this tab`, { status: 409 })
      this.pick(body.block, body.agent)
      return Response.json({ agent: body.agent })
    }
    if (rest === "send" && req.method === "POST") {
      // { block, agent, text }: a message from a tool in pane `block`, which
      // picks `agent` if given; or, outside Rex, straight to `agent`
      const body: unknown = await req.json().catch(() => null)
      if (!isRecord(body) || !isString(body.text) || !body.text.trim())
        return new Response("bad text", { status: 400 })
      const block = isString(body.block) ? body.block : null
      const agent = isString(body.agent) ? body.agent : null
      if (!block) {
        const address = agent && this.reach(agent)
        if (!address) return new Response("no agent to send to", { status: 409 })
        try {
          await postTo(address, `${RELAYED}\n\n${body.text}`)
        } catch (e) {
          return new Response(`couldn't post to ${agent}: ${e}`, { status: 502 })
        }
        return Response.json({ status: "sent" })
      }
      // As in homeOf: right after a start, Rex's first RexState may be on its way
      await Promise.race([this.#firstRex, new Promise((r) => setTimeout(r, 500))])
      if (agent) {
        if (!this.agentsNear(block).includes(agent))
          return new Response(`${agent} isn't a live agent in this tab`, { status: 409 })
        this.pick(block, agent)
      }
      return Response.json({ status: await this.send(block, body.text) })
    }
    if (rest !== "") return new Response("not found", { status: 404 })
    const all = new URL(req.url).searchParams.has("all")
    const processes = await readClaudeProcesses()
    const agents = listAgents(this.registry, processes, this.#rex)
    return Response.json(all ? agents : agents.filter(isCurrent))
  }
}
