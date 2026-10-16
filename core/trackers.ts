// The tracker role, per workspace: each workspace has one current tracker,
// what "the tracker" means for agents there and what the dashboard shows in
// its tabs, and the trackers it has had, each active, parked or done. Kept
// in the registry (registry.ts) by workspace root.
//
// Adding a tracker makes it active and current. Active ones are listed to
// switch between. Parking one (work left) or finishing it (none) takes it
// out of the list, and out of the role if it's current; the one used before
// it takes over. Resuming or adding it again brings it back. An active one
// gone a week unused, neither added nor resumed nor its file changed, is listed
// as parked until it's used again, unless it's current.

import { statSync } from "node:fs"
import {
  fileKind,
  type RexState,
  type Requestable,
  type TrackerEntry,
  type TrackerRecord,
  type TrackerStatus,
  type WorkspaceRecord,
  type WorkspaceRoot,
  type WorkspaceTrackers,
} from "./model.ts"
import type { Registry } from "./registry.ts"
import { rootFinder, tabRoot } from "./workspace.ts"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** A file's subject, by its extension */
export const subjectOf = (path: string): Requestable => ({ kind: fileKind(path), path })

const mtime = (path: string): number | null => {
  try {
    const s = statSync(path)
    return s.isFile() ? s.mtimeMs : null
  } catch {
    return null
  }
}

const byRecent = (entries: TrackerEntry[]) =>
  entries.sort((a, b) => b.lastOpen - a.lastOpen)

interface Source {
  registry: Registry
  rex: () => RexState | null
  /** Called after every change, with what changed, for the log */
  changed: (change: object) => void
}

export class Trackers {
  #source: Source

  constructor(source: Source) {
    this.#source = source
  }

  get #records(): Map<WorkspaceRoot, WorkspaceRecord> {
    return this.#source.registry.trackers
  }

  /** The workspace a tab or agent is in: its jj workspace, or outside one
   * its directory. null for an agent with no directory, or a tab that's
   * gone. */
  workspaceOf(home: string): WorkspaceRoot | null {
    const rootOf = rootFinder()
    const tab = this.#source
      .rex()
      ?.sessions.flatMap((s) => s.tabs)
      .find((t) => t.id === home)
    if (tab) {
      const focused = tab.blocks.find((b) => b.id === tab.focused) ?? tab.blocks[0]
      return tabRoot(tab, rootOf) ?? focused?.cwd ?? null
    }
    const cwd = this.#source.registry.agents.get(home)?.cwd
    return cwd ? (rootOf(cwd) ?? cwd) : null
  }

  /** The workspace's trackers whose files are still there, with their
   * status as listed: an active one gone a week unused is parked */
  #listed(root: WorkspaceRoot, now: number) {
    const record = this.#records.get(root)
    if (!record) return []
    return record.trackers.flatMap((t) => {
      const changed = mtime(t.path)
      if (changed === null) return []
      const used = Math.max(t.used, changed)
      const aged = t.path !== record.current && now - used >= WEEK_MS
      const status: TrackerStatus = t.status === "active" && aged ? "parked" : t.status
      return [{ ...t, used, status }]
    })
  }

  get(root: WorkspaceRoot, now = Date.now()): WorkspaceTrackers {
    const listed = this.#listed(root, now)
    const entries = (status: TrackerStatus) =>
      byRecent(
        listed
          .filter((t) => t.status === status)
          .map((t) => ({ subject: subjectOf(t.path), lastOpen: t.used })),
      )
    const current = this.currentPath(root)
    return {
      current: current ? subjectOf(current) : null,
      active: entries("active"),
      parked: entries("parked"),
    }
  }

  /** The workspace's finished trackers, most recent first */
  done(root: WorkspaceRoot): TrackerEntry[] {
    return byRecent(
      this.#listed(root, Date.now())
        .filter((t) => t.status === "done")
        .map((t) => ({ subject: subjectOf(t.path), lastOpen: t.used })),
    )
  }

  /** The current tracker's file, unless it's gone */
  currentPath(root: WorkspaceRoot): string | null {
    const current = this.#records.get(root)?.current ?? null
    return current && mtime(current) !== null ? current : null
  }

  /** A tracker's status as listed, or null if it isn't one */
  statusOf(path: string, now = Date.now()): TrackerStatus | null {
    for (const root of this.#records.keys()) {
      const t = this.#listed(root, now).find((t) => t.path === path)
      if (t) return t.status
    }
    return null
  }

  /** Make `path` the workspace's current tracker, and active if it wasn't */
  add(root: WorkspaceRoot, path: string, now = Date.now()) {
    let record = this.#records.get(root)
    if (!record) this.#records.set(root, (record = { current: null, trackers: [] }))
    const t = record.trackers.find((t) => t.path === path)
    if (t) Object.assign(t, { status: "active", used: now })
    else record.trackers.push({ path, status: "active", used: now })
    record.current = path
    this.#source.changed({ add: path, root })
  }

  /** Park a tracker, finish it, or resume it. Returns whether it's a
   * tracker anywhere. */
  setStatus(path: string, status: TrackerStatus, now = Date.now()): boolean {
    let found = false
    for (const record of this.#records.values()) {
      const t = record.trackers.find((t) => t.path === path)
      if (!t) continue
      found = true
      t.status = status
      if (status === "active") t.used = now
      else if (record.current === path) record.current = next(record, now)
    }
    if (found) this.#source.changed({ status, path })
    return found
  }

  /** Forget the trackers whose files are gone, and workspaces that are
   * gone or have none left. Returns whether anything went. */
  prune(): boolean {
    let pruned = false
    for (const [root, record] of this.#records) {
      const kept = record.trackers.filter((t) => mtime(t.path) !== null)
      if (kept.length < record.trackers.length) pruned = true
      record.trackers = kept
      if (record.current && !kept.some((t) => t.path === record.current)) {
        record.current = null
        pruned = true
      }
      if (!kept.length || !isDir(root)) {
        this.#records.delete(root)
        pruned = true
      }
    }
    if (pruned) this.#source.changed({ pruned: true })
    return pruned
  }
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Who takes over from the current tracker: the active one used last, as
 * long as it's been used in the last week */
function next(record: WorkspaceRecord, now: number): string | null {
  let best: TrackerRecord | null = null
  for (const t of record.trackers) {
    if (t.path === record.current || t.status !== "active") continue
    const changed = mtime(t.path)
    if (changed === null || now - Math.max(t.used, changed) >= WEEK_MS) continue
    if (!best || t.used > best.used) best = t
  }
  return best?.path ?? null
}
