// The core: the agents, and where requests for them go. Its routes, under
// /core/: GET the agents as JSON,
// from the registry and Rex's latest state (`?all` includes ones
// that aren't in a block or running any more), POST `event` for the
// hooks (cli/hook.ts) to report into the registry, which answers with what the
// hook should tell the agent (notices.ts), POST `current-tracker` to set,
// read, or clear an agent's workspace's current tracker, GET `trackers`
// for one workspace's,
// and POST `tracker-status` to park or finish one (trackers.ts). The CLI's
// client for the tracker routes is cli/tracker.ts. GET `agents-near`, POST
// `pick` and `send` are for `ah message send` and a file shown from a
// shell, which the directory (directory.ts) answers.
//
// The core owns the registry. Each event is applied synchronously, then the
// registry is saved (debounced) and listeners hear which blocks changed;
// a prompt's summary runs after, and is applied the same way when it's
// ready. Events and summary outcomes are logged to registry-events.jsonl for
// working out afterwards why a title was what it was.

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isString, str } from "../platform/guards.ts"
import { rotateLog } from "../platform/paths.ts"
import {
  claudeSocket,
  parseAddress,
  parseAgentRef,
  postTo,
  readClaudeProcesses,
} from "../platform/session.ts"
import {
  type Address,
  type AgentId,
  type AgentRef,
  type BlockId,
  fileSubject,
  HARNESSES,
  HOOK_EVENTS,
  type NearbyAgent,
  type RexState,
  type WorkspaceRoot,
} from "../model.ts"
import { Directory, RELAYED } from "./directory.ts"
import { Notices, type Showing, startContext } from "./notices.ts"
import { Trackers } from "./trackers.ts"
import { doctorNotice, type Outdated, Upgrades } from "./upgrades.ts"
import { focusedBlock, pickBlock, readTuis } from "./tuis.ts"
import { rootFinder } from "./workspace.ts"
import {
  agentId,
  apply,
  applySummary,
  blockOf,
  emptyRegistry,
  loadRegistry,
  prune,
  type Registry,
  type RegistryEvent,
  registryFile,
  saveRegistry,
  type SummaryJob,
} from "./registry.ts"
import { type AgentView, isCurrent, listAgents } from "./agent_view.ts"
import { buildSummaryPayload, cleanSummary, generateSummary } from "./summary.ts"

/** A posted event, checked, or null if it isn't one */
function parseEvent(o: unknown): RegistryEvent | null {
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

/** Every block in Rex, in a tab or not. null when there are no sessions,
 * which means Rex isn't running (or ah can't reach it), not that every
 * block closed. */
const liveBlocks = (rex: RexState | null): Set<string> | null =>
  rex?.sessions.length
    ? new Set(
        rex.sessions
          .flatMap((s) => [...s.tabs.flatMap((t) => t.blocks), ...s.detached])
          .map((b) => b.id),
      )
    : null

/** The tab a block is in */
const tabOf = (rex: RexState | null, block: string) =>
  rex?.sessions.flatMap((s) => s.tabs).find((t) => t.blocks.some((x) => x.id === block)) ??
  null

type Listener = (registry: Registry, blocks: string[]) => void

/** No agent to send to: none given, or it can't be reached */
export class NoAgent extends Error {
  constructor(reason = "no agent to send to") {
    super(reason)
  }
}

export class Core {
  readonly registry: Registry
  readonly trackers: Trackers
  readonly directory: Directory
  #rex: RexState | null = null
  #firstRex: Promise<void>
  #gotRex = () => {}
  #listeners: Listener[] = []
  #notices = new Notices()
  /** Files in people's repos that use an old ah format */
  #upgrades = new Upgrades([])
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
    this.directory = new Directory({
      registry,
      rex: () => this.#rex,
      save: () => this.#scheduleSave(),
    })
    this.#file = file
    this.#log = join(dirname(file), "registry-events.jsonl")
    mkdirSync(dirname(file), { recursive: true })
    rotateLog(this.#log)
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
    // A stop exits on SIGTERM, which would drop a change from the last 200ms
    process.on("exit", () => {
      if (core.#saveTimer) core.#save()
    })
    return core
  }

  /** Where to find what windows show, for telling agents when a file they
   * opened stops showing */
  watchShowing(showing: () => Showing) {
    this.#showing = showing
  }

  /** Where files that use an old ah format are kept track of, for telling
   * agents and for `ah doctor`. Checks every tracker it has a record of. */
  useUpgrades(upgrades: Upgrades) {
    this.#upgrades = upgrades
    upgrades.scan(
      [...this.registry.trackers.values()].flatMap((w) => w.trackers.map((t) => t.path)),
    )
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
    this.directory.onRex(rex)
    if (prune(this.registry, liveBlocks(rex), new Set(this.#recent.keys())))
      this.#changed([])
  }

  /** Apply one event; what the event endpoint does. Returns the agent it
   * was for, if any. `address` is where the agent says it can be reached. */
  receive(event: RegistryEvent, address: Address | null = null): string | null {
    try {
      const located = this.#locate(event)
      if (!this.#nested(located)) return this.#apply(located, address)
      this.#write("nested", event)
      return null
    } catch (e) {
      console.error(`ah: couldn't apply an event: ${e}`)
      return null
    }
  }

  /** Whether the event is from a Claude session in a pane whose agent is
   * another Claude session that hasn't ended and still runs: a `claude -p`
   * the agent ran, which its hooks can't tell when the agent's session
   * started before they exported AH_SESSION (cli/hook.ts). /clear and
   * /resume end the first session before the next one starts. */
  #nested(event: RegistryEvent): boolean {
    if (event.kind !== "hook" || event.harness !== "claude" || !event.block) return false
    const record = this.registry.agents.get(event.block)
    return (
      record?.harness === "claude" &&
      record.session !== event.session &&
      !record.ended &&
      claudeSocket(record.session) !== null
    )
  }

  /** Where the agent `ref` names is, for finding its workspace: the tab
   * its pane is in, or the agent's id outside Rex or for a pane the
   * RexState doesn't have, as while `rex events` reconnects */
  async homeOf(ref: AgentRef): Promise<string | null> {
    const id = agentId(this.registry, ref)
    const record = id ? this.registry.agents.get(id) : undefined
    const block = ref.block ?? (record && blockOf(record)) ?? null
    if (!block) return id
    await this.#rexReady()
    return tabOf(this.#rex, block)?.id ?? id
  }

  /** Right after the server starts, Rex's first RexState may still be on
   * its way. For a request from a Rex pane, so it won't be long. */
  #rexReady(): Promise<unknown> {
    return Promise.race([this.#firstRex, new Promise((r) => setTimeout(r, 500))])
  }

  /** The files that use an old ah format in the workspace at `root`, or in
   * all with null. A file is in the workspace its path is in, any whose
   * trackers it's among, and the one the agent it's bound to is in. */
  #outdatedIn(root: WorkspaceRoot | null): Outdated[] {
    const all = this.#upgrades.outdated()
    if (root === null) return all
    const rootOf = rootFinder()
    const inRoot = (path: string) => {
      const own = rootOf(path)
      // Outside jj, a workspace is a directory, holding what's under it
      if (own === root || (own === null && path.startsWith(`${root}/`))) return true
      if (this.registry.trackers.get(root)?.trackers.some((t) => t.path === path))
        return true
      const cwd = this.registry.agents.get(
        this.directory.binding(fileSubject(path)) ?? "",
      )?.cwd
      return !!cwd && (rootOf(cwd) ?? cwd) === root
    }
    return all.filter((o) => inRoot(o.path))
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
      const active = this.trackers.get(root).active.map((t) => t.path)
      const doctor = doctorNotice(this.#outdatedIn(root))
      const lines = [startContext(current, active), doctor].filter(Boolean)
      return lines.length ? lines.join("\n\n") : null
    }
    // A workspace not known now leaves its tracker as last told
    const lines = this.#notices.since(agent, root ? current : undefined, this.#showing())
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
    return { ...event, block }
  }

  #apply(event: RegistryEvent, address: Address | null): string | null {
    // Enough of a prompt to tell which it was: in full, they'd grow the log
    // by megabytes a week
    const prompt = event.kind === "hook" ? event.prompt?.slice(0, 300) : undefined
    this.#write("event", prompt === undefined ? event : { ...event, prompt })
    const { agent, blocks, summarize } = apply(this.registry, event)
    // Before listeners hear of it, so a page bound to the agent can reach it
    if (agent && event.kind === "hook") this.directory.heard(agent, event.harness, address)
    for (const t of blocks) this.#recent.set(t, Date.now())
    this.#changed(blocks)
    if (summarize) {
      this.#summarize(summarize).catch((e) => console.error(`ah: couldn't summarize: ${e}`))
    }
    return agent
  }

  /** A summary from the harness itself, e.g. opencode's session title */
  retitle(session: string, title: string) {
    const summary = cleanSummary(title)
    const id = agentId(this.registry, {
      harness: "opencode",
      session,
      block: null,
      process: null,
    })
    const record = id ? this.registry.agents.get(id) : undefined
    if (!summary || !record || record.session !== session || record.summary === summary)
      return
    this.#write("summary", { agent: id, sequence: record.promptSequence, summary })
    record.summary = summary
    record.summarySequence = record.promptSequence
    const block = blockOf(record)
    this.#changed(block ? [block] : [])
  }

  async #summarize(job: SummaryJob) {
    const payload = await buildSummaryPayload(job.transcript, job.priorSummary, job.prompt)
    const fields = { agent: job.agent, session: job.session, sequence: job.sequence }
    if (!payload)
      return this.#write("summary-skipped", { ...fields, reason: "no messages" })
    const result = await generateSummary(payload)
    if ("skipped" in result)
      return this.#write("summary-skipped", { ...fields, reason: result.skipped })
    const { summary } = result
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
      // { agent, path }: add it and make it current, or with `current: false`
      // only add it; without `path`, read it
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
      const current = body.current !== false
      this.trackers.add(root, body.path, Date.now(), { current })
      const agent = agentId(this.registry, ref)
      if (agent && current) this.#notices.madeCurrent(agent, body.path)
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
    if (rest === "upgrades" && req.method === "GET")
      // ?root=: the files that use an old format, in that workspace or all
      return Response.json(this.#outdatedIn(new URL(req.url).searchParams.get("root")))
    if (rest === "agents-near" && req.method === "GET") {
      // ?block=: the live agents in its tab, in its layout order
      const block = new URL(req.url).searchParams.get("block")
      if (!block) return new Response("bad block", { status: 400 })
      await this.#rexReady()
      const near = this.directory.agentsNear(block)
      const target = this.directory.targetNear(block, near)
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
      if (!this.directory.agentsNear(body.block).includes(body.agent))
        return new Response(`${body.agent} isn't a live agent in this tab`, { status: 409 })
      this.directory.pick(body.block, body.agent)
      return Response.json({ agent: body.agent })
    }
    if (rest === "send" && req.method === "POST") {
      // { block, agent, cwd, text }: a message from a tool in pane `block`
      // to `agent`, which becomes its pick, or else to the agent it sends to
      // (targetNear); or, outside Rex, straight to `agent`, else to an agent
      // in the workspace of `cwd`, where the tool runs. With none to take
      // it, the route refuses with the reason. The message isn't kept for the
      // next agent, which may have started for something else.
      const body: unknown = await req.json().catch(() => null)
      if (!isRecord(body) || !isString(body.text) || !body.text.trim())
        return new Response("bad text", { status: 400 })
      const block = isString(body.block) ? body.block : null
      const agent = isString(body.agent) ? body.agent : null
      const cwd = isString(body.cwd) ? body.cwd : null
      try {
        await this.sendTo(
          block ? await this.#targetIn(block, agent) : agent,
          body.text,
          cwd,
        )
      } catch (e) {
        const status = e instanceof NoAgent ? 409 : 502
        return new Response((e as Error).message, { status })
      }
      return Response.json({ status: "sent" })
    }
    if (rest !== "") return new Response("not found", { status: 404 })
    return Response.json(this.agents(new URL(req.url).searchParams.has("all")))
  }

  /** The agent a message from pane `block` goes to: `agent`, which becomes
   * the pane's pick, or the one it sends to. Throws NoAgent if there's none. */
  async #targetIn(block: BlockId, agent: AgentId | null): Promise<AgentId> {
    await this.#rexReady()
    const near = this.directory.agentsNear(block)
    if (agent) {
      if (!near.includes(agent))
        throw new NoAgent(`${agent} isn't a live agent in this tab`)
      this.directory.pick(block, agent)
      return agent
    }
    const target = this.directory.targetNear(block, near)
    if (target) return target
    throw new NoAgent(
      near.length
        ? `this tab has ${near.length} agents; pass --agent with one of them (ah workspace agents)`
        : "no agent in this tab",
    )
  }

  /** Post `text` to `agent` as a message from a tool, like
   * skepsis's Send, or if it's gone, to an agent in the workspace of `cwd`.
   * Throws NoAgent if there's none to reach. */
  async sendTo(
    agent: AgentId | null,
    text: string,
    cwd: string | null = null,
  ): Promise<void> {
    const address = agent && this.directory.reach(agent, cwd)
    if (!address) throw new NoAgent()
    try {
      await postTo(address, `${RELAYED}\n\n${text}`)
    } catch (e) {
      throw new Error(`couldn't post to ${agent}: ${e}`)
    }
  }

  /** The live agents, or with `all`, also the ones that aren't in a block
   * or running any more */
  agents(all = false): AgentView[] {
    const agents = listAgents(this.registry, readClaudeProcesses(), this.#rex)
    return all ? agents : agents.filter(isCurrent)
  }
}
