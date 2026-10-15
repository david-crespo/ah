// A tab's title: each terminal in the tab whose agent it shows contributes
// the agent's label, unless the terminal before it had the same label, then
// its summary. Components are joined with " | ". With no
// sessions, the first shell label in the tab; when that's empty too,
// undefined, and the tab is left alone. While a prompt's summary is being
// written, the previous one stays. Busy state isn't in it: Rex shows its own
// indicator.
//
//   ah | Port tab titles | Refocus the README
//   └label └summary  └second terminal's summary, same label so not repeated

import type { Registry } from "../sessions/registry.ts"

export function tabTitle(terminalIds: string[], r: Registry): string | undefined {
  const entries = terminalIds.flatMap((terminal) => {
    const agent = r.agents.get(terminal)
    return agent?.shown ? [{ label: agent.label, summary: agent.summary }] : []
  })
  const components = entries.flatMap((entry, i) => [
    ...(i === 0 || entries[i - 1].label !== entry.label ? [entry.label] : []),
    ...(entry.summary ? [entry.summary] : []),
  ])
  const fallback = terminalIds.map((t) => r.shellLabels.get(t)).find(Boolean)
  return components.join(" | ") || fallback
}
