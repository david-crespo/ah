// The agent registry: one record per agent, which is whatever runs in a Rex
// pane, kept across the harness sessions it goes through (/clear, a
// restart). Each record has the agent's current session, whether it's busy,
// and its summary. Beside them, each workspace's trackers (trackers.ts).
// Agent hooks and zsh push
// events (`ah hook agent` and `shell`, posted to
// /core/event), and the server applies them one at a time, so
// nothing races.
//
// An agent's home is its pane, the Rex block, or outside Rex its process
// (`claude-<pid>`, as platform/session.ts has it), and its id comes from that.
// One with no home, from an event from Codex's daemon that the server
// couldn't place, is keyed by its session (`codex:<id>`).
//
// The pane keeps showing its agent after Stop or SessionEnd, so an idle pane
// keeps its summary, until the shell in it changes directory. One that ended
// counts in the tab title only while no other agent there is running
// (tabtitle/title.ts). The record itself lasts as long as the pane.
//
// `apply` only changes state, synchronously, and returns what to do next: the
// blocks whose tabs need a new title, and a summary to start. The caller
// does the async parts afterwards, so two events can't interleave.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isOneOf, isRecord, isString, isStringOrNull } from "../platform/guards.ts"
import { ahStateDir } from "../platform/paths.ts"
import {
  type AgentId,
  type AgentRecord,
  type AgentRef,
  type BlockId,
  HARNESSES,
  type Harness,
  type Home,
  type TrackerStatus,
  type WorkspaceRecord,
  type WorkspaceRoot,
} from "./model.ts"

/** What ah keeps on disk about agents, trackers and files */
export interface Registry {
  agents: Map<AgentId, AgentRecord>
  trackers: Map<WorkspaceRoot, WorkspaceRecord>
  /** zsh's label for each block's directory */
  shellLabels: Map<BlockId, string>
  /** File path -> the agent its requests go to */
  bindings: Map<string, AgentId>
  /** A shell pane -> the agent in its tab it picked, for the messages it
   * sends and the files it opens */
  picks: Map<BlockId, AgentId>
  /** A pane -> the messages it sent that no agent has taken yet, oldest
   * first, to send when one turns up in its tab */
  outbox: Map<BlockId, string[]>
  /** Files whose threads hold requests no agent has taken, to send when
   * one turns up */
  held: Set<string>
}

export const emptyRegistry = (): Registry => ({
  agents: new Map(),
  trackers: new Map(),
  shellLabels: new Map(),
  bindings: new Map(),
  picks: new Map(),
  outbox: new Map(),
  held: new Set(),
})

/** An agent's id, from its home */
export function idOf(home: Home | null, harness: Harness, session: string): AgentId {
  switch (home?.kind) {
    case "block":
      return home.block
    case "process":
      return home.process
    case undefined:
      return `${harness}:${session}`
  }
}

/** The block an agent runs in, if it's in Rex */
export const blockOf = (a: AgentRecord): BlockId | null =>
  a.home?.kind === "block" ? a.home.block : null

/** The id of the agent `ref` names: its pane, else the agent that has its
 * session (the one showing it, if the session moved panes), else its
 * process, else its session */
export function agentId(r: Registry, ref: AgentRef): AgentId | null {
  if (ref.block) return ref.block
  if (ref.session) {
    let found: [AgentId, AgentRecord] | null = null
    for (const [id, a] of r.agents) {
      if (a.harness !== ref.harness || a.session !== ref.session) continue
      const better =
        !found || (a.shown === found[1].shown ? a.updatedAt > found[1].updatedAt : a.shown)
      if (better) found = [id, a]
    }
    if (found) return found[0]
  }
  if (ref.process) return ref.process
  return ref.session ? idOf(null, ref.harness, ref.session) : null
}

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

export type RegistryEvent =
  | {
      kind: "hook"
      event: HookEventName
      harness: Harness
      session: string
      /** REX_BLOCK in the hook's env. Without it the agent is keyed by its
       * process and claims no block, so an agent run with a stripped env
       * can't take over another's pane. */
      block: BlockId | null
      /** The agent's process key, when there's no block */
      process: string | null
      /** The cwd abbreviated, for when the block has no shell label */
      label: string
      cwd: string | null
      prompt?: string
      transcript?: string
    }
  | { kind: "shell"; block: BlockId; label: string }

export interface SummaryJob {
  agent: AgentId
  session: string
  sequence: number
  transcript: string
  prompt?: string
  priorSummary: string | null
}

export interface Applied {
  /** The agent the event was for, if it was a hook's */
  agent: AgentId | null
  /** Blocks whose tab's title may have changed */
  blocks: BlockId[]
  summarize: SummaryJob | null
}

export function apply(r: Registry, e: RegistryEvent, now = Date.now()): Applied {
  if (e.kind === "shell") {
    r.shellLabels.set(e.block, e.label)
    const agent = r.agents.get(e.block)
    if (agent) agent.shown = false
    return { agent: null, blocks: [e.block], summarize: null }
  }

  const id = agentId(r, e)!
  const blocks: BlockId[] = []
  // The same session in another pane (resumed there) leaves the first one
  for (const [otherId, other] of r.agents) {
    if (otherId === id || other.harness !== e.harness || other.session !== e.session)
      continue
    const otherBlock = blockOf(other)
    if (other.shown && otherBlock) blocks.push(otherBlock)
    other.shown = false
  }
  const previous = r.agents.get(id)
  // A new session in the pane (/clear, a restart, another harness) starts
  // over
  const same = previous?.session === e.session && previous.harness === e.harness
  // The label is the one the session started with in its pane: the shell's
  // label there if it reported one, else the hook's. It stays even if the
  // directory changes since.
  // An event with no block (from Codex's daemon, unplaced) keeps the home
  // the session's agent has
  const home: Home | null = e.block
    ? { kind: "block", block: e.block }
    : (previous?.home ?? (e.process ? { kind: "process", process: e.process } : null))
  const block = home?.kind === "block" ? home.block : null
  const label = (block && r.shellLabels.get(block)) || e.label
  const fresh = e.event === "SessionStart" || !same
  const record: AgentRecord = {
    home,
    harness: e.harness,
    session: e.session,
    label: fresh || !previous ? label : previous.label,
    cwd: e.cwd ?? (same ? previous.cwd : null),
    busy: same ? previous.busy : false,
    shown: true,
    ended: e.event === "SessionEnd",
    promptSequence: same ? previous.promptSequence : 0,
    summary: same ? previous.summary : null,
    summarySequence: same ? previous.summarySequence : 0,
    updatedAt: now,
  }
  let summarize: SummaryJob | null = null
  if (e.event === "UserPromptSubmit") {
    record.busy = true
    record.promptSequence++
    if (e.transcript) {
      summarize = {
        agent: id,
        session: e.session,
        sequence: record.promptSequence,
        transcript: e.transcript,
        prompt: e.prompt,
        priorSummary: record.summary,
      }
    }
  } else if (e.event === "Stop" || e.event === "SessionEnd") {
    record.busy = false
  }
  r.agents.set(id, record)
  if (block) blocks.push(block)
  return { agent: id, blocks, summarize }
}

/** Record a finished summary. Returns the block to retitle, if the summary
 * is for the agent's current session and newer than the one it has. */
export function applySummary(
  r: Registry,
  job: Pick<SummaryJob, "agent" | "session" | "sequence">,
  summary: string,
): BlockId | null {
  const record = r.agents.get(job.agent)
  if (!record || record.session !== job.session || job.sequence <= record.summarySequence)
    return null
  record.summary = summary
  record.summarySequence = job.sequence
  return blockOf(record)
}

/** Drop what nothing will need again: agents in panes Rex no longer has,
 * agents outside Rex with no event for a week, and the labels, picks and
 * unsent messages of closed blocks.
 * `live` is every block in the tree; pass null when Rex isn't running, so quitting it
 * doesn't forget everything, and only age counts. `recent` are blocks an
 * event just named, which the last RexState may not have caught up with.
 * Returns whether anything went. */
export function prune(
  r: Registry,
  live: Set<BlockId> | null,
  recent: Set<BlockId> = new Set(),
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): boolean {
  const gone = (block: BlockId) => live && !live.has(block) && !recent.has(block)
  let changed = false
  for (const [id, a] of r.agents) {
    const block = blockOf(a)
    const stale = now - a.updatedAt > maxAgeMs && !(block && live?.has(block))
    if ((block && gone(block)) || stale) {
      r.agents.delete(id)
      changed = true
    }
  }
  for (const blocks of [r.shellLabels, r.picks, r.outbox]) {
    for (const block of blocks.keys()) {
      if (gone(block)) {
        blocks.delete(block)
        changed = true
      }
    }
  }
  return changed
}

export function registryFile(): string {
  return ahStateDir("registry.json")
}

interface Stored {
  agents: Record<string, AgentRecord>
  trackers: Record<string, WorkspaceRecord>
  shellLabels: Record<string, string>
  bindings: Record<string, AgentId>
  picks: Record<string, AgentId>
  outbox: Record<string, string[]>
  held: string[]
}

/** The registry as last saved, or null if it never was. Entries that don't
 * have the right shape are dropped. */
export function loadRegistry(file = registryFile()): Registry | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  return {
    agents: entries(raw.agents, isAgentRecord),
    trackers: entries(raw.trackers, isWorkspaceRecord),
    shellLabels: entries(raw.shellLabels, isString),
    bindings: entries(raw.bindings, isString),
    picks: entries(raw.picks, isString),
    outbox: entries(raw.outbox, isStrings),
    held: new Set(Array.isArray(raw.held) ? raw.held.filter(isString) : []),
  }
}

const isHome = (h: unknown): h is Home =>
  isRecord(h) &&
  ((h.kind === "block" && isString(h.block)) ||
    (h.kind === "process" && isString(h.process)))

function isAgentRecord(r: unknown): r is AgentRecord {
  return (
    isRecord(r) &&
    (r.home === null || isHome(r.home)) &&
    isOneOf(HARNESSES, r.harness) &&
    typeof r.session === "string" &&
    typeof r.label === "string" &&
    isStringOrNull(r.cwd) &&
    typeof r.busy === "boolean" &&
    typeof r.shown === "boolean" &&
    typeof r.ended === "boolean" &&
    typeof r.promptSequence === "number" &&
    isStringOrNull(r.summary) &&
    typeof r.summarySequence === "number" &&
    typeof r.updatedAt === "number"
  )
}

const STATUSES: readonly TrackerStatus[] = ["active", "parked", "done"]

const isWorkspaceRecord = (w: unknown): w is WorkspaceRecord =>
  isRecord(w) &&
  isStringOrNull(w.current) &&
  Array.isArray(w.trackers) &&
  w.trackers.every(
    (t) =>
      isRecord(t) &&
      typeof t.path === "string" &&
      isOneOf(STATUSES, t.status) &&
      typeof t.used === "number",
  )

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

function entries<T>(value: unknown, is: (v: unknown) => v is T): Map<string, T> {
  const map = new Map<string, T>()
  if (!isRecord(value)) return map
  for (const [key, v] of Object.entries(value)) if (is(v)) map.set(key, v)
  return map
}

export function saveRegistry(r: Registry, file = registryFile()) {
  const stored: Stored = {
    agents: Object.fromEntries(r.agents),
    trackers: Object.fromEntries(r.trackers),
    shellLabels: Object.fromEntries(r.shellLabels),
    bindings: Object.fromEntries(r.bindings),
    picks: Object.fromEntries(r.picks),
    outbox: Object.fromEntries(r.outbox),
    held: [...r.held],
  }
  mkdirSync(dirname(file), { recursive: true })
  // Rename over the old file so a crash mid-write can't leave half of one
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(stored))
  renameSync(tmp, file)
}
