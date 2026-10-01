// A tab's title, computed as ghostty-tab-title (GTT, which this replaced)
// built it: each terminal in the tab that has a session visible in it
// contributes the session's label, unless the terminal before it had the
// same label, then its state and summary. Components are joined with " | ".
// With no sessions, the first shell label in the tab; when that's empty too,
// undefined, and the tab is left alone. While a prompt's summary is being
// written, the previous one stays (GTT showed the state alone).
//
//   ah | 🌀 Port tab titles | Refocus the README
//   └label └state + summary └second terminal's summary, same label so not repeated

import type { Registry } from "../sessions/registry.ts"

export function tabTitle(terminalIds: string[], r: Registry): string | undefined {
  const entries = terminalIds.flatMap((terminal) => {
    const id = r.visible.get(terminal)
    const session = id ? r.sessions.get(id) : undefined
    // The session must still name this terminal: one that moved to another
    // pane has left a stale entry here
    if (!session || session.terminalId !== terminal) return []
    const activity = [session.state, session.summary].filter(Boolean).join(" ")
    return [{ label: session.label, activity }]
  })
  const components = entries.flatMap((entry, i) => [
    ...(i === 0 || entries[i - 1].label !== entry.label ? [entry.label] : []),
    ...(entry.activity ? [entry.activity] : []),
  ])
  const fallback = terminalIds.map((t) => r.shellLabels.get(t)).find(Boolean)
  return components.join(" | ") || fallback
}
