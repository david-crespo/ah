// The agent registry: one record per agent, which is whatever runs in a Rex
// pane, kept across the harness sessions it goes through (/clear, a
// restart). Each record has the agent's current session, whether it's busy,
// and its summary. Beside them, each tab's file in the dashboard, usually
// the tracker its agents work from: it belongs to the tab, so any agent
// starting in the tab picks it up. Agent hooks and zsh push
// events (`ah hook agent` and `shell`, posted to
// /app/sessions/event), and the server applies them one at a time, so
// nothing races.
//
// An agent is keyed by its pane, the Rex block. Outside Rex it's keyed by
// its process (`claude-<pid>`, as host/session.ts has it), or failing that
// its session (`codex:<id>`, for an event from Codex's daemon that the
// server couldn't place).
//
// The pane keeps showing its agent after Stop or SessionEnd, so an idle pane
// keeps its summary, until the shell in it changes directory. The record
// itself lasts as long as the pane.
//
// `apply` only changes state, synchronously, and returns what to do next: the
// terminals whose tabs need a new title, and a summary to start. The caller
// does the async parts afterwards, so two events can't interleave.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isOneOf, isRecord, isString, isStringOrNull } from "../../host/guards.ts"
import { ahStateDir } from "../../host/paths.ts"

export const HARNESSES = ["claude", "codex", "opencode", "pi"] as const
export type Harness = (typeof HARNESSES)[number]

export interface AgentRecord {
  /** The Rex block it runs in, null outside Rex */
  block: string | null
  harness: Harness
  /** Its current harness session */
  session: string
  label: string
  cwd: string | null
  /** A prompt is running */
  busy: boolean
  /** Its pane shows it: false once the shell there changed directory, or the
   * session moved to another pane */
  shown: boolean
  /** Bumped by every prompt, so a slow summary can't replace a newer one */
  promptSequence: number
  /** The latest summary written, and the prompt it was for. The title shows
   * it while the current prompt's summary is still being written. */
  summary: string | null
  summarySequence: number
  /** ms since the epoch: last event for this agent */
  updatedAt: number
}

export interface ShownFile {
  path: string
  /** ms since the epoch */
  since: number
}

export interface Registry {
  /** By agent id: the block, process key, or harness and session */
  agents: Map<string, AgentRecord>
  /** By home, the tab its agents are in, or for an agent outside Rex its id:
   * the file the dashboard shows */
  files: Map<string, ShownFile>
  /** terminal id → zsh's label for its directory */
  shellLabels: Map<string, string>
}

export const emptyRegistry = (): Registry => ({
  agents: new Map(),
  files: new Map(),
  shellLabels: new Map(),
})

/** What a command or hook run by an agent knows about which one it is */
export interface AgentRef {
  harness: Harness
  session: string | null
  /** REX_BLOCK */
  terminal: string | null
  /** host/session.ts's process key, for agents outside Rex */
  process?: string | null
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** An agent a command names, checked, or null if it isn't one */
export function parseAgentRef(o: unknown): AgentRef | null {
  if (!isRecord(o) || !isOneOf(HARNESSES, o.harness)) return null
  return {
    harness: o.harness,
    session: str(o.session),
    terminal: str(o.terminal),
    process: str(o.process),
  }
}

/** The id of the agent `ref` names: its pane, else the agent that has its
 * session (the one showing it, if the session moved panes), else its
 * process, else its session */
export function agentId(r: Registry, ref: AgentRef): string | null {
  if (ref.terminal) return ref.terminal
  if (ref.session) {
    let found: [string, AgentRecord] | null = null
    for (const [id, a] of r.agents) {
      if (a.harness !== ref.harness || a.session !== ref.session) continue
      const better =
        !found || (a.shown === found[1].shown ? a.updatedAt > found[1].updatedAt : a.shown)
      if (better) found = [id, a]
    }
    if (found) return found[0]
  }
  if (ref.process) return ref.process
  return ref.session ? `${ref.harness}:${ref.session}` : null
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
       * process and claims no terminal, so an agent run with a stripped env
       * can't take over another's pane. */
      terminal: string | null
      /** The agent's process key, when there's no terminal */
      process?: string | null
      /** The cwd abbreviated, for when the terminal has no shell label */
      label: string
      cwd: string | null
      prompt?: string
      transcript?: string
    }
  | { kind: "shell"; terminal: string; label: string }

export interface SummaryJob {
  agent: string
  session: string
  sequence: number
  transcript: string
  prompt?: string
  priorSummary: string | null
}

export interface Applied {
  /** The agent the event was for, if it was a hook's */
  agent: string | null
  /** Terminals whose tab's title may have changed */
  terminals: string[]
  summarize: SummaryJob | null
}

export function apply(r: Registry, e: RegistryEvent, now = Date.now()): Applied {
  if (e.kind === "shell") {
    r.shellLabels.set(e.terminal, e.label)
    const agent = r.agents.get(e.terminal)
    if (agent) agent.shown = false
    return { agent: null, terminals: [e.terminal], summarize: null }
  }

  const id = agentId(r, e)!
  const terminals: string[] = []
  // The same session in another pane (resumed there) leaves the first one
  for (const [otherId, other] of r.agents) {
    if (otherId === id || other.harness !== e.harness || other.session !== e.session)
      continue
    if (other.shown && other.block) terminals.push(other.block)
    other.shown = false
  }
  const previous = r.agents.get(id)
  // A new session in the pane (/clear, a restart, another harness) starts
  // over
  const same = previous?.session === e.session && previous.harness === e.harness
  // The label is the one the session started with in its pane: the shell's
  // label there if it reported one, else the hook's. It stays even if the
  // directory changes since.
  // An event with no terminal (from Codex's daemon, unplaced) keeps the pane
  // the session's agent is in
  const block = e.terminal ?? previous?.block ?? null
  const label = (block && r.shellLabels.get(block)) || e.label
  const fresh = e.event === "SessionStart" || !same
  const record: AgentRecord = {
    block,
    harness: e.harness,
    session: e.session,
    label: fresh || !previous ? label : previous.label,
    cwd: e.cwd ?? (same ? previous.cwd : null),
    busy: same ? previous.busy : false,
    shown: true,
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
  if (block) terminals.push(block)
  return { agent: id, terminals, summarize }
}

/** Record a finished summary. Returns the terminal to retitle, if the summary
 * is for the agent's current session and newer than the one it has. */
export function applySummary(
  r: Registry,
  job: Pick<SummaryJob, "agent" | "session" | "sequence">,
  summary: string,
): string | null {
  const record = r.agents.get(job.agent)
  if (!record || record.session !== job.session || job.sequence <= record.summarySequence)
    return null
  record.summary = summary
  record.summarySequence = job.sequence
  return record.block
}

/** Set or clear the file `home` shows in the dashboard. Returns the one it
 * had. */
export function setFile(
  r: Registry,
  home: string,
  path: string | null,
  now = Date.now(),
): string | null {
  const previous = r.files.get(home)?.path ?? null
  if (path) r.files.set(home, { path, since: now })
  else r.files.delete(home)
  return previous
}

/** Clear `path` from whichever homes have it. Returns how many did. */
export function clearFile(r: Registry, path: string): number {
  let cleared = 0
  for (const [home, file] of r.files) {
    if (file.path !== path) continue
    r.files.delete(home)
    cleared++
  }
  return cleared
}

/** Drop what nothing will need again: agents in panes Rex no longer has,
 * agents outside Rex with no event for a week, files of closed tabs and
 * dropped agents, and labels of closed terminals. `live` is every tab and
 * terminal in the tree; pass null when Rex isn't running, so quitting it
 * doesn't forget everything, and only age counts. `recent` are terminals an
 * event just named, which the last snapshot may not have caught up with.
 * Returns whether anything went. */
export function prune(
  r: Registry,
  live: { tabs: Set<string>; terminals: Set<string> } | null,
  recent: Set<string> = new Set(),
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): boolean {
  const gone = (terminal: string) =>
    live && !live.terminals.has(terminal) && !recent.has(terminal)
  const stale = (a: AgentRecord) =>
    now - a.updatedAt > maxAgeMs && !(a.block && live?.terminals.has(a.block))
  let changed = false
  for (const [id, a] of r.agents) {
    if ((a.block && gone(a.block)) || stale(a)) {
      r.agents.delete(id)
      changed = true
    }
  }
  for (const home of r.files.keys()) {
    if (live && !live.tabs.has(home) && !r.agents.has(home)) {
      r.files.delete(home)
      changed = true
    }
  }
  for (const terminal of r.shellLabels.keys()) {
    if (gone(terminal)) {
      r.shellLabels.delete(terminal)
      changed = true
    }
  }
  return changed
}

export function registryFile(): string {
  return ahStateDir("registry.json")
}

interface Stored {
  agents: Record<string, AgentRecord>
  files: Record<string, ShownFile>
  shellLabels: Record<string, string>
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
    files: entries(raw.files, isShownFile),
    shellLabels: entries(raw.shellLabels, isString),
  }
}

function isAgentRecord(r: unknown): r is AgentRecord {
  return (
    isRecord(r) &&
    isStringOrNull(r.block) &&
    isOneOf(HARNESSES, r.harness) &&
    typeof r.session === "string" &&
    typeof r.label === "string" &&
    isStringOrNull(r.cwd) &&
    typeof r.busy === "boolean" &&
    typeof r.shown === "boolean" &&
    typeof r.promptSequence === "number" &&
    isStringOrNull(r.summary) &&
    typeof r.summarySequence === "number" &&
    typeof r.updatedAt === "number"
  )
}

const isShownFile = (f: unknown): f is ShownFile =>
  isRecord(f) && typeof f.path === "string" && typeof f.since === "number"

function entries<T>(value: unknown, is: (v: unknown) => v is T): Map<string, T> {
  const map = new Map<string, T>()
  if (!isRecord(value)) return map
  for (const [key, v] of Object.entries(value)) if (is(v)) map.set(key, v)
  return map
}

export function saveRegistry(r: Registry, file = registryFile()) {
  const stored: Stored = {
    agents: Object.fromEntries(r.agents),
    files: Object.fromEntries(r.files),
    shellLabels: Object.fromEntries(r.shellLabels),
  }
  mkdirSync(dirname(file), { recursive: true })
  // Rename over the old file so a crash mid-write can't leave half of one
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(stored))
  renameSync(tmp, file)
}
