// Agents in one shape across harnesses, and where they are in Rex. Two
// sources: ah's hook-fed registry (registry.ts), which covers every harness
// with hooks and knows each agent's pane, and Claude's own registry,
// ~/.claude/sessions/<pid>.json, which exists only while the process runs
// and has its inbox socket.

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

export interface AgentView {
  id: string
  harness: Harness
  /** Its current harness session */
  session: string
  label: string
  cwd: string | null
  busy: boolean
  summary: string | null
  /** Its pane shows it (see AgentRecord) */
  shown: boolean
  /** Its pane, null outside Rex */
  terminal: string | null
  /** Where that pane is now, or null if it's gone */
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

/** Every agent in the registry, plus running Claude sessions it doesn't have */
export function listAgents(
  registry: Registry,
  processes: ClaudeProcess[],
  snapshot: Snapshot | null,
): AgentView[] {
  const places = new Map<string, { window: string; tab: string }>()
  for (const w of snapshot?.windows ?? []) {
    for (const t of w.tabs) {
      for (const term of t.terminals) places.set(term.id, { window: w.id, tab: t.id })
    }
  }
  const bySession = new Map(processes.map((p) => [p.sessionId, p]))
  const listed = [...registry.agents].map(([id, a]): AgentView => {
    const p = a.harness === "claude" ? bySession.get(a.session) : undefined
    bySession.delete(a.session)
    return {
      id,
      harness: a.harness,
      session: a.session,
      label: a.label,
      cwd: a.cwd,
      busy: a.busy,
      summary: a.summary,
      shown: a.shown,
      terminal: a.block,
      place: a.block ? (places.get(a.block) ?? null) : null,
      process: p ? { pid: p.pid, status: p.status, socket: p.socket } : null,
    }
  })
  // Running, but no hook has reported it
  const unreported = [...bySession.values()].map((p): AgentView => ({
    id: `claude-${p.pid}`,
    harness: "claude",
    session: p.sessionId,
    label: p.cwd ? basename(p.cwd) : "",
    cwd: p.cwd,
    busy: p.status === "busy",
    summary: null,
    shown: false,
    terminal: null,
    place: null,
    process: { pid: p.pid, status: p.status, socket: p.socket },
  }))
  return [...listed, ...unreported]
}
