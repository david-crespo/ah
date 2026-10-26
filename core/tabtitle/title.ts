// A tab's title: each block in the tab whose agent it shows contributes
// the agent's label, unless the block before it had the same label, then
// its summary. Components are joined with " | ". An agent whose session
// ended counts only when none in the tab is still running, and then only the
// last to end: a side agent that's closed drops out, and the tab's main one
// keeps its title after it ends. With no
// sessions, the first shell label in the tab; when that's empty too,
// undefined, and the tab is left alone. While a prompt's summary is being
// written, the previous one stays. Busy state isn't in it: Rex shows its own
// indicator.
//
//   ah | Port tab titles | Refocus the README
//   └label └summary  └second block's summary, same label so not repeated

import type { AgentRecord } from "../model.ts"
import type { Registry } from "../registry.ts"

export function tabTitle(blockIds: string[], r: Registry): string | undefined {
  const shown = blockIds.flatMap((block) => {
    const agent = r.agents.get(block)
    return agent?.shown ? [agent] : []
  })
  const running = shown.filter((a) => !a.ended)
  const lastEnded = shown.reduce<AgentRecord[]>(
    (last, a) => (last.length && last[0].updatedAt >= a.updatedAt ? last : [a]),
    [],
  )
  const entries = running.length ? running : lastEnded
  const components = entries.flatMap((entry, i) => [
    ...(i === 0 || entries[i - 1].label !== entry.label ? [entry.label] : []),
    ...(entry.summary ? [entry.summary] : []),
  ])
  const fallback = blockIds.map((t) => r.shellLabels.get(t)).find(Boolean)
  return components.join(" | ") || fallback
}
