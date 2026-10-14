// Agent sessions in one shape across harnesses, and where they are in
// Rex. Two sources: ah's hook-fed registry (registry.ts), which covers
// every harness with hooks and knows each session's terminal, and Claude's
// own registry, ~/.claude/sessions/<pid>.json, which exists only while the
// process runs and has its inbox socket.

import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { claudeSessionsDir } from "../../host/paths.ts"
import type { Snapshot } from "../../host/rex.ts"
import type { Harness, Registry } from "./registry.ts"

export interface ClaudeProcess {
  pid: number
  sessionId: string
  cwd: string
  /** "busy" or "idle" */
  status: string
  socket: string | null
}

export interface AgentSession {
  id: string
  harness: Harness
  label: string
  cwd: string | null
  busy: boolean
  summary: string | null
  /** The terminal it's shown in: null once another session or a cd in that
   * terminal took it over, or for a session whose hooks never said */
  terminal: string | null
  /** Where that terminal is now, or null if it's gone */
  place: { window: string; tab: string } | null
  /** Claude only, while the process runs */
  process: { pid: number; status: string; socket: string | null } | null
}

export async function readClaudeProcesses(): Promise<ClaudeProcess[]> {
  const dir = claudeSessionsDir()
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    /^\d+\.json$/.test(f),
  )
  const read = await Promise.all(
    files.map(async (f): Promise<ClaudeProcess | null> => {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), "utf8"))
        if (typeof raw.sessionId !== "string") return null
        return {
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          status: raw.status ?? "",
          socket: raw.messagingSocketPath ?? null,
        }
      } catch {
        return null
      }
    }),
  )
  return read.filter((p) => p !== null)
}

/** Every session in the registry, plus running Claude sessions it doesn't have */
export function listSessions(
  registry: Registry,
  processes: ClaudeProcess[],
  snapshot: Snapshot | null,
): AgentSession[] {
  const places = new Map<string, { window: string; tab: string }>()
  for (const w of snapshot?.windows ?? []) {
    for (const t of w.tabs) {
      for (const term of t.terminals) places.set(term.id, { window: w.id, tab: t.id })
    }
  }
  const byId = new Map(processes.map((p) => [p.sessionId, p]))
  const shownIn = new Map([...registry.visible].map(([terminal, id]) => [id, terminal]))

  const ids = new Set([...registry.sessions.keys(), ...byId.keys()])
  return [...ids].map((id): AgentSession => {
    const g = registry.sessions.get(id)
    const p = byId.get(id)
    const cwd = g?.cwd ?? p?.cwd ?? null
    const terminal = shownIn.get(id) ?? null
    return {
      id,
      // Not in the registry means it came from Claude's
      harness: g?.harness ?? "claude",
      label: g?.label ?? (cwd ? basename(cwd) : ""),
      cwd,
      busy: g ? g.busy : p?.status === "busy",
      summary: g?.summary ?? null,
      terminal,
      place: terminal ? (places.get(terminal) ?? null) : null,
      process: p ? { pid: p.pid, status: p.status, socket: p.socket } : null,
    }
  })
}
