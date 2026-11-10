// Agents in one shape across harnesses, and where they are in Rex. Two
// sources: ah's hook-fed registry (registry.ts), which covers every harness
// with hooks and knows each agent's pane, and Claude's own registry,
// <config dir>/sessions/<pid>.json, which exists only while the process runs
// and has its inbox socket (platform/session.ts reads it).

import { basename } from "node:path"
import type { ClaudeProcess } from "../platform/session.ts"
import type { AgentId, AgentRecord, BlockId, RexState, TabId } from "../model.ts"
import { blockOf, type Registry } from "./registry.ts"

export interface AgentView extends Pick<
  AgentRecord,
  "harness" | "session" | "label" | "cwd" | "busy" | "summary" | "shown" | "ended"
> {
  id: AgentId
  /** Its pane, null outside Rex */
  block: BlockId | null
  /** The tab that pane is in now, or null if it's gone */
  tab: TabId | null
  /** Claude only, while the process runs */
  process: Pick<ClaudeProcess, "pid" | "status" | "socket"> | null
}

/** In a block that still exists, or running */
export const isCurrent = (a: AgentView) => a.tab !== null || a.process !== null

/** Every agent in the registry, plus running Claude sessions it doesn't have */
export function listAgents(
  registry: Registry,
  processes: ClaudeProcess[],
  rex: RexState | null,
): AgentView[] {
  const tabs = new Map<string, string>()
  for (const s of rex?.sessions ?? []) {
    for (const t of s.tabs) {
      for (const b of t.blocks) tabs.set(b.id, t.id)
    }
  }
  const bySession = new Map(processes.map((p) => [p.sessionId, p]))
  const listed = [...registry.agents].map(([id, a]): AgentView => {
    const p = a.harness === "claude" ? bySession.get(a.session) : undefined
    bySession.delete(a.session)
    const block = blockOf(a)
    return {
      id,
      harness: a.harness,
      session: a.session,
      label: a.label,
      cwd: a.cwd,
      busy: a.busy,
      summary: a.summary,
      shown: a.shown,
      ended: a.ended,
      block,
      tab: block ? (tabs.get(block) ?? null) : null,
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
    ended: false,
    block: null,
    tab: null,
    process: { pid: p.pid, status: p.status, socket: p.socket },
  }))
  return [...listed, ...unreported]
}
