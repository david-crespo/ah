// Turn a RexState into the dashboard's tabs: which jj workspace each tab
// is in, which one is focused, and the order to list them in.

import { basename, dirname } from "node:path"
import type { RexState } from "../../core/model.ts"
import { type RootOf, tabRoot } from "../../core/workspace.ts"

/** A Rex tab in a jj workspace, as the dashboard shows it */
export interface DashTab {
  id: string
  /** The Rex session it's in */
  session: string
  /** The workspace's name, numbered when another tab shows the same one */
  name: string
  /** The tab's own title */
  title: string
  root: string
}

export interface State {
  /** The tab showing in Rex, or the last one that was in a workspace */
  focused: string | null
  tabs: DashTab[]
}

/** The focused tab's workspace */
export const focusedRoot = (state: State): string | null =>
  state.tabs.find((t) => t.id === state.focused)?.root ?? null

/**
 * Tabs that are in a workspace, in tab order, windows ordered by id so the
 * list doesn't reshuffle when another window comes to the front. When the
 * focused tab isn't in a workspace, the previous focus stays (if that tab is
 * still open).
 */
export function resolve(rex: RexState, rootOf: RootOf, previous: string | null): State {
  const found: Omit<DashTab, "name">[] = []
  let focused: string | null = null
  const sessions = [...rex.sessions].sort((a, b) => a.id.localeCompare(b.id))
  for (const s of sessions) {
    for (const tab of s.tabs) {
      const root = tabRoot(tab, rootOf)
      if (!root) continue
      found.push({ id: tab.id, session: s.id, title: tab.name, root })
      if (s.id === rex.front && tab.id === s.selectedTab) focused = tab.id
    }
  }
  if (!focused && previous && found.some((t) => t.id === previous)) focused = previous
  const roots = [...new Set(found.map((t) => t.root))]
  const seen = new Map<string, number>()
  const tabs = found.map((t) => {
    const n = (seen.get(t.root) ?? 0) + 1
    seen.set(t.root, n)
    const name = displayName(t.root, roots)
    return { ...t, name: n > 1 ? `${name} ${n}` : name }
  })
  return { focused, tabs }
}

/** Basename, plus the parent dir when another open workspace has the same basename. */
function displayName(root: string, roots: string[]): string {
  const name = basename(root)
  const clash = roots.some((r) => r !== root && basename(r) === name)
  return clash ? `${basename(dirname(root))}/${name}` : name
}
