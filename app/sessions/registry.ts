// The session registry: which agent session is shown in which Ghostty
// terminal, whether it's busy, and its summary. Agent hooks and zsh push
// events (`ah app sessions hook` and `shell`, posted to
// /app/sessions/event), and the server applies them one at a time. This
// replaced ghostty-tab-title (GTT), a script in the user's dotfiles that kept
// the same model in files, one per entry, written by every hook process at
// once, so it needed version tokens, retries and atomic writes. With one
// process applying events in order, nothing races.
//
// The mapping is sticky, as in GTT: a session stays shown in its terminal
// after Stop or SessionEnd, so an idle pane keeps its summary, until another
// session claims the terminal or the shell in it changes directory.
//
// `apply` only changes state, synchronously, and returns what to do next: the
// terminals whose tabs need a new title, and a summary to start. The caller
// does the async parts afterwards, so two events can't interleave.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isString, isStringOrNull } from "../../host/guards.ts"

export const HARNESSES = ["claude", "codex", "opencode", "pi"] as const
export type Harness = (typeof HARNESSES)[number]

export interface SessionRecord {
  /** The terminal it last ran in, null if its hooks never said. Its
   * `visible` entry may have moved on since. */
  terminalId: string | null
  /** null for sessions imported from GTT, which didn't record it */
  harness: Harness | null
  label: string
  cwd: string | null
  /** "🌀" while a prompt runs, "" otherwise */
  state: string
  /** Bumped by every prompt, so a slow summary can't replace a newer one */
  promptSequence: number
  /** The latest summary written, and the prompt it was for. The title shows
   * it while the current prompt's summary is still being written. */
  summary: string | null
  summarySequence: number
  /** ms since the epoch: last event for this session */
  updatedAt: number
}

export interface Registry {
  sessions: Map<string, SessionRecord>
  /** terminal id → the session shown in it */
  visible: Map<string, string>
  /** terminal id → zsh's label for its directory */
  shellLabels: Map<string, string>
}

export const emptyRegistry = (): Registry => ({
  sessions: new Map(),
  visible: new Map(),
  shellLabels: new Map(),
})

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
      /** GHOSTTY_TERMINAL_ID in the hook's env. Without it the session is
       * recorded but claims no terminal: GTT fell back to the focused pane,
       * which let an agent run with a stripped env take over someone else's. */
      terminal: string | null
      label: string
      cwd: string | null
      prompt?: string
      transcript?: string
    }
  | { kind: "shell"; terminal: string; label: string }

export interface SummaryJob {
  session: string
  sequence: number
  transcript: string
  prompt?: string
  priorSummary: string | null
}

export interface Applied {
  /** Terminals whose tab's title may have changed */
  terminals: string[]
  summarize: SummaryJob | null
}

export function apply(r: Registry, e: RegistryEvent, now = Date.now()): Applied {
  if (e.kind === "shell") {
    r.shellLabels.set(e.terminal, e.label)
    r.visible.delete(e.terminal)
    return { terminals: [e.terminal], summarize: null }
  }

  const previous = r.sessions.get(e.session)
  const terminals: string[] = []
  // The hook's own terminal wins over the stored one, so a session resumed in
  // another pane follows it there
  const terminalId = e.terminal ?? previous?.terminalId ?? null
  if (previous?.terminalId && previous.terminalId !== terminalId) {
    if (r.visible.get(previous.terminalId) === e.session) {
      r.visible.delete(previous.terminalId)
    }
    terminals.push(previous.terminalId)
  }
  // The label is the one the session started with in its terminal, even if
  // its directory changes since. A session resumed in another tab (Codex
  // sends no SessionStart for that) takes the new tab's.
  const fresh =
    e.event === "SessionStart" || !previous || terminalId !== previous.terminalId
  const record: SessionRecord = {
    terminalId,
    harness: e.harness,
    label: fresh ? e.label : previous.label,
    cwd: e.cwd ?? previous?.cwd ?? null,
    state: previous?.state ?? "",
    promptSequence: previous?.promptSequence ?? 0,
    summary: previous?.summary ?? null,
    summarySequence: previous?.summarySequence ?? 0,
    updatedAt: now,
  }
  let summarize: SummaryJob | null = null
  if (e.event === "UserPromptSubmit") {
    record.state = "🌀"
    record.promptSequence++
    if (e.transcript) {
      summarize = {
        session: e.session,
        sequence: record.promptSequence,
        transcript: e.transcript,
        prompt: e.prompt,
        priorSummary: record.summary,
      }
    }
  } else if (e.event === "Stop" || e.event === "SessionEnd") {
    record.state = ""
  }
  r.sessions.set(e.session, record)
  if (terminalId) {
    r.visible.set(terminalId, e.session)
    terminals.push(terminalId)
  }
  return { terminals, summarize }
}

/** Record a finished summary. Returns the terminal to retitle, if the summary
 * is newer than the one the session has. */
export function applySummary(
  r: Registry,
  session: string,
  sequence: number,
  summary: string,
): string | null {
  const record = r.sessions.get(session)
  if (!record || sequence <= record.summarySequence) return null
  record.summary = summary
  record.summarySequence = sequence
  return record.terminalId
}

/** Drop what nothing will need again: sessions with no event for a week (GTT
 * kept the same), and mappings and labels of terminals Ghostty no longer has.
 * `live` is every terminal in the tree; pass null when Ghostty isn't running,
 * so quitting it doesn't forget everything. `recent` are terminals an event
 * just named, which a poller up to 2s behind may not have seen yet. Returns
 * whether anything went. */
export function prune(
  r: Registry,
  live: Set<string> | null,
  recent: Set<string> = new Set(),
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): boolean {
  let changed = false
  for (const [id, s] of r.sessions) {
    if (now - s.updatedAt > maxAgeMs) {
      r.sessions.delete(id)
      changed = true
    }
  }
  for (const map of [r.visible, r.shellLabels]) {
    for (const [terminal, value] of map) {
      const dangling = map === r.visible && !r.sessions.has(value)
      if (dangling || (live && !live.has(terminal) && !recent.has(terminal))) {
        map.delete(terminal)
        changed = true
      }
    }
  }
  return changed
}

export function registryFile(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateHome, "ah", "registry.json")
}

interface Stored {
  sessions: Record<string, SessionRecord>
  visible: Record<string, string>
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
    sessions: entries(raw.sessions, isSessionRecord),
    visible: entries(raw.visible, isString),
    shellLabels: entries(raw.shellLabels, isString),
  }
}

function isSessionRecord(r: unknown): r is SessionRecord {
  return (
    isRecord(r) &&
    isStringOrNull(r.terminalId) &&
    (r.harness === null || isOneOf(HARNESSES, r.harness)) &&
    typeof r.label === "string" &&
    isStringOrNull(r.cwd) &&
    typeof r.state === "string" &&
    typeof r.promptSequence === "number" &&
    isStringOrNull(r.summary) &&
    typeof r.summarySequence === "number" &&
    typeof r.updatedAt === "number"
  )
}

function entries<T>(value: unknown, is: (v: unknown) => v is T): Map<string, T> {
  const map = new Map<string, T>()
  if (!isRecord(value)) return map
  for (const [key, v] of Object.entries(value)) if (is(v)) map.set(key, v)
  return map
}

export function saveRegistry(r: Registry, file = registryFile()) {
  const stored: Stored = {
    sessions: Object.fromEntries(r.sessions),
    visible: Object.fromEntries(r.visible),
    shellLabels: Object.fromEntries(r.shellLabels),
  }
  mkdirSync(dirname(file), { recursive: true })
  // Rename over the old file so a crash mid-write can't leave half of one
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(stored))
  renameSync(tmp, file)
}
