// What an agent is told by its hooks (`ah hook agent`, which prints the
// server's reply): on SessionStart, its workspace's active trackers with the
// current one marked; on UserPromptSubmit, one line for each thing that
// changed since it was last told, and nothing when nothing did. Nothing is
// pushed: any number of tab clicks or closed windows between prompts come to
// at most one line each, with the last state, read when the agent starts on
// your message. It misses only a change in the middle of a turn.
//
// What changes:
// - the workspace's current tracker, the one the dashboard shows, which is
//   what an unqualified "do 3" refers to
// - a view the agent opened (`ah view open`) that no window shows any more
// - the dashboard, closed
//
// What each agent was last told is in memory. After a server restart an
// agent's first hook sets it without saying anything.

import type { AgentId } from "./model.ts"

/** A file open in the server, as the agent's notices need it */
export interface OpenFileState {
  path: string
  /** The agent it's bound to */
  agent: AgentId | null
  /** Some window shows it, or did a moment ago */
  open: boolean
}

/** What's showing now */
export interface Showing {
  files: OpenFileState[]
  dashboard: boolean
}

interface Told {
  current: string | null
  /** Bound views by path: whether the agent last knew it as open */
  files: Map<string, boolean>
  dashboard: boolean
}

/** What a starting session is told about its workspace's trackers, or null
 * if it has none */
export function startContext(current: string | null, active: string[]): string | null {
  const paths = current && !active.includes(current) ? [current, ...active] : active
  if (!paths.length) return null
  const lines = paths.map((p) => `- ${p}${p === current ? " (current)" : ""}`)
  return [
    `Active trackers in this workspace (\`ah tracker ls\`). The ah dashboard ` +
      `shows the current one, which is what a request that doesn't name a ` +
      `tracker refers to.`,
    ...lines,
    `When picking up work, check the tracker it belongs to, and keep it updated.`,
  ].join("\n")
}

export class Notices {
  #told = new Map<AgentId, Told>()

  /** A session starting: it's told the trackers (startContext), and knows
   * the rest as it is now */
  start(agent: AgentId, current: string | null, showing: Showing) {
    this.#told.set(agent, told(agent, current, showing))
  }

  /** The agent made `path` current itself, so it needn't be told */
  madeCurrent(agent: AgentId, path: string) {
    const t = this.#told.get(agent)
    if (t) t.current = path
  }

  /** What changed since the agent was last told, a line each */
  since(agent: AgentId, current: string | null, showing: Showing): string[] {
    const last = this.#told.get(agent)
    const now = told(agent, current, showing)
    this.#told.set(agent, now)
    if (!last) return []
    const lines: string[] = []
    if (now.current !== last.current)
      lines.push(
        now.current
          ? `ah: the dashboard now shows ${now.current} as this workspace's current tracker`
          : `ah: this workspace has no current tracker now`,
      )
    for (const [path, open] of now.files) {
      // One the agent opened since it was last told counts as known open
      if (!open && last.files.get(path) !== false)
        lines.push(`ah: no window shows ${path}, which you opened, any more`)
    }
    if (last.dashboard && !now.dashboard) lines.push(`ah: the dashboard is closed now`)
    return lines
  }
}

const told = (agent: AgentId, current: string | null, showing: Showing): Told => ({
  current,
  files: new Map(
    showing.files.filter((v) => v.agent === agent).map((v) => [v.path, v.open]),
  ),
  dashboard: showing.dashboard,
})
