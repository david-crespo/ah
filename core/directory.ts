// The agent directory: where each agent can be reached now, which agents are
// live, and where requests for them go. Files' requests find their agents
// here (subjects/files/files.ts): which agent each file is bound to, kept in
// the registry, and where that agent can be reached now, which `open` and
// Claude's hooks say. And which files hold requests no agent took, to send
// when one turns up. A plain message from a tool in a Rex pane (`ah message
// send`): the user's editor or a diff review, goes to the agent in its tab,
// and waits in the pane's outbox until one is there.
//
// The core (core.ts) owns the registry and tells the directory about each
// event and RexState.

import { dirname } from "node:path"
import { addressAlive, claudeSocket, postTo } from "../platform/session.ts"
import {
  type Address,
  type AgentId,
  type AgentRef,
  type BlockId,
  fileSubject,
  type Harness,
  type RexState,
  type Route,
  type Subject,
} from "../model.ts"
import type { AgentDirectory } from "../subjects/files/files.ts"
import { agentId, blockOf, type Registry } from "./registry.ts"
import { rootFinder } from "./workspace.ts"

/** Ahead of every plain message `ah message send` relays */
export const RELAYED =
  "From the user, through ah: treat it as typed here and answer in the terminal, not with SendMessage."

const liveTabs = (rex: RexState | null): Set<string> | null =>
  rex?.sessions.length
    ? new Set(rex.sessions.flatMap((s) => s.tabs.map((t) => t.id)))
    : null

interface Source {
  registry: Registry
  rex: () => RexState | null
  /** Called after a change to the registry, to save it */
  save: () => void
}

export class Directory implements AgentDirectory {
  #source: Source
  /** By agent id: where it can be reached, from the last `open` or hook
   * that said */
  #addresses = new Map<string, Address>()
  /** Each block's tab, kept after the block closes for as long as the
   * tab is open, so a closed pane's comments find the rest of its tab */
  #tabs = new Map<string, string>()
  /** By pane: the flush of its outbox under way, so its messages go one at
   * a time, in order */
  #flushing = new Map<BlockId, Promise<void>>()

  constructor(source: Source) {
    this.#source = source
  }

  get #registry(): Registry {
    return this.#source.registry
  }

  onRex(rex: RexState) {
    const tabs = liveTabs(rex)
    for (const tab of rex.sessions.flatMap((s) => s.tabs))
      for (const t of tab.blocks) this.#tabs.set(t.id, tab.id)
    if (tabs) for (const [t, tab] of this.#tabs) if (!tabs.has(tab)) this.#tabs.delete(t)
  }

  /** A hook event from `agent`, run by `harness`. `address` is where the
   * hook said it can be reached; without one, the address of another
   * harness in its pane is no use. */
  heard(agent: AgentId, harness: Harness, address: Address | null) {
    if (address) this.#addresses.set(agent, address)
    else if (this.#addresses.get(agent)?.harness !== harness) this.#addresses.delete(agent)
  }

  agentId(ref: AgentRef): AgentId | null {
    return agentId(this.#registry, ref)
  }

  bind(agent: AgentId, address: Address | null) {
    if (address) this.#addresses.set(agent, address)
  }

  bindSubject({ path }: Subject, agent: AgentId) {
    if (this.#registry.bindings.get(path) === agent) return
    this.#registry.bindings.set(path, agent)
    this.#source.save()
  }

  binding({ path }: Subject): AgentId | null {
    return this.#registry.bindings.get(path) ?? null
  }

  route(subject: Subject): Route | null {
    const agent = this.binding(subject)
    const own = agent && this.address(agent)
    if (own && addressAlive(own)) return { address: own, via: "agent" }
    const standIn = agent && this.standIn(agent)
    if (standIn) return { address: standIn, via: "tab" }
    const workspace = this.#liveInWorkspace(dirname(subject.path))
    if (workspace) return { address: workspace, via: "workspace" }
    return own ? { address: own, via: "agent" } : null
  }

  /** The live agent working in `dir`'s workspace that last did something,
   * for a file or message whose own agent and its tab are gone: a tracker
   * whose session closed, a draft from one, or a diff review opened from one */
  #liveInWorkspace(dir: string): Address | null {
    const rootOf = rootFinder()
    const root = rootOf(dir)
    if (!root) return null
    const best = this.#latest(
      [...this.#registry.agents]
        .filter(([id, a]) => a.cwd && rootOf(a.cwd) === root && this.#live(id))
        .map(([id]) => id),
    )
    return best ? this.address(best) : null
  }

  /** Where to post to `agent` now: its own address while that's alive, else
   * its stand-in's, else that of the live agent in `dir`'s workspace */
  reach(agent: AgentId, dir: string | null = null): Address | null {
    const own = this.address(agent)
    if (addressAlive(own)) return own
    return this.standIn(agent) ?? (dir ? this.#liveInWorkspace(dir) : null) ?? own
  }

  hold({ path }: Subject, held: boolean) {
    if (this.#registry.held.has(path) === held) return
    if (held) this.#registry.held.add(path)
    else this.#registry.held.delete(path)
    this.#source.save()
  }

  /** The subjects whose threads hold requests, to send when agents come and go */
  get held(): Subject[] {
    return [...this.#registry.held].map(fileSubject)
  }

  /** Codex and opencode are reached by their session, so an agent's is
   * always the one it's in now, even after Codex's /new. Claude is reached
   * by its process's inbox socket, which lasts through /clear; a new process
   * in the pane reports its own from its hooks. Until it has, or after the
   * server restarts, the socket comes from Claude's record of the session.
   * null once its session ended. */
  address(agent: string): Address | null {
    const known = this.#addresses.get(agent) ?? null
    const record = this.#registry.agents.get(agent)
    if (!record) return known
    if (record.ended) return null
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
    const record = this.#registry.agents.get(agent)
    const standIn = this.#latest(
      this.#liveInTab((record && blockOf(record)) ?? agent, agent),
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
    const picked = this.#registry.picks.get(block)
    if (picked && near.includes(picked)) return picked
    if (near.includes(block)) return block
    return near.length === 1 ? near[0] : null
  }

  pick(block: BlockId, agent: AgentId) {
    if (this.#registry.picks.get(block) === agent) return
    this.#registry.picks.set(block, agent)
    this.#source.save()
  }

  /** A message from a tool in pane `block` to the agent it sends to
   * (targetNear), after any it sent before that are still waiting. Whatever
   * no agent takes waits in the pane's outbox for the next flush. */
  async send(block: BlockId, text: string): Promise<"sent" | "held"> {
    const waiting = this.#registry.outbox.get(block) ?? []
    waiting.push(`${RELAYED}\n\n${text}`)
    this.#registry.outbox.set(block, waiting)
    this.#source.save()
    await this.#flush(block)
    return this.#registry.outbox.has(block) ? "held" : "sent"
  }

  /** Send every pane's waiting messages to the agent it sends to, if one is
   * there now: for when agents come and go */
  async flush() {
    await Promise.all([...this.#registry.outbox.keys()].map((block) => this.#flush(block)))
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
    const waiting = this.#registry.outbox.get(block)
    if (!address || !waiting) return
    while (waiting.length) {
      try {
        await postTo(address, waiting[0])
      } catch (e) {
        console.error(`ah: couldn't post to ${target}; its messages wait:`, e)
        return
      }
      waiting.shift()
      this.#source.save()
    }
    this.#registry.outbox.delete(block)
  }

  /** The live agents in `block`'s tab other than `except`, in its layout
   * order */
  #liveInTab(block: BlockId, except: AgentId | null): AgentId[] {
    const tabId = this.#tabs.get(block)
    const tab = this.#source
      .rex()
      ?.sessions.flatMap((s) => s.tabs)
      .find((t) => t.id === tabId)
    if (!tab) return []
    return tab.blocks.map((b) => b.id).filter((id) => id !== except && this.#live(id))
  }

  /** Whether the agent still shows in its pane, and can be reached */
  #live(id: AgentId): boolean {
    return !!this.#registry.agents.get(id)?.shown && addressAlive(this.address(id))
  }

  /** Of agents with records, the one that last did something */
  #latest(ids: AgentId[]): AgentId | null {
    const updated = (id: AgentId) => this.#registry.agents.get(id)!.updatedAt
    return ids.reduce<AgentId | null>(
      (best, id) => (best && updated(best) >= updated(id) ? best : id),
      null,
    )
  }
}
