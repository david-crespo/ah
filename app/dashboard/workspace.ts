// Turn a Rex snapshot into the dashboard's tabs: which jj workspace each tab
// is in, which one is focused, and the order to list them in.

import { statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Snapshot, Tab } from "../../host/rex.ts"

/** A Rex tab in a jj workspace, as the dashboard shows it */
export interface DashTab {
  id: string
  /** The Rex session (snapshot window) it's in */
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

export type RootOf = (dir: string) => string | null

/** Nearest ancestor of `dir` (inclusive) containing `.jj`, cached by dir for
 * the finder's lifetime, so make one per snapshot */
export function rootFinder(): RootOf {
  const cache = new Map<string, string | null>()
  const isWorkspace = (dir: string) => {
    try {
      return statSync(join(dir, ".jj")).isDirectory()
    } catch {
      return false
    }
  }
  const find = (dir: string): string | null => {
    if (!dir.startsWith("/")) return null
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const parent = dirname(dir)
    const root = isWorkspace(dir) ? dir : parent === dir ? null : find(parent)
    cache.set(dir, root)
    return root
  }
  return find
}

/**
 * The workspace most of a tab's terminals are in. Going by the focused
 * terminal alone isn't reliable: a pane can report a stale directory (a
 * terminal-browser pane reports its temp dir), so it only breaks ties.
 */
export function tabRoot(tab: Tab, rootOf: RootOf): string | null {
  const counts = new Map<string, number>()
  for (const t of tab.terminals) {
    const root = rootOf(t.cwd)
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  const max = Math.max(0, ...counts.values())
  const tied = [...counts].filter(([, n]) => n === max).map(([root]) => root)
  if (tied.length <= 1) return tied[0] ?? null
  const focused = tab.terminals.find((t) => t.id === tab.focused)
  const focusedRoot = focused && rootOf(focused.cwd)
  return focusedRoot && tied.includes(focusedRoot) ? focusedRoot : tied[0]
}

/**
 * Tabs that are in a workspace, in tab order, windows ordered by id so the
 * list doesn't reshuffle when another window comes to the front. When the
 * focused tab isn't in a workspace, the previous focus stays (if that tab is
 * still open).
 */
export function resolve(
  snapshot: Snapshot,
  rootOf: RootOf,
  previous: string | null,
): State {
  const found: Omit<DashTab, "name">[] = []
  let focused: string | null = null
  const windows = [...snapshot.windows].sort((a, b) => a.id.localeCompare(b.id))
  for (const w of windows) {
    for (const tab of w.tabs) {
      const root = tabRoot(tab, rootOf)
      if (!root) continue
      found.push({ id: tab.id, session: w.id, title: tab.name, root })
      if (w.id === snapshot.front && tab.id === w.selectedTab) focused = tab.id
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
