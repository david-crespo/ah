// The file each open workspace shows in the dashboard: the newest one
// registered by a live session in that workspace (see docs.ts). Reports a change when a
// record changes or a session starts or exits; the page shows the file with
// <ah-markdown>, which follows edits to it on its own.

import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { type Dirs, liveRecords } from "./docs.ts"

export interface Doc {
  path: string
}

export class DocView {
  #roots = new Set<string>()
  #current = new Map<string, Doc>()
  #watchers: FSWatcher[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #poll: ReturnType<typeof setInterval>

  /** `onChange` gets null when a workspace stops having a file */
  readonly dirs: Dirs
  readonly onChange: (root: string, doc: Doc | null) => void

  constructor(dirs: Dirs, onChange: (root: string, doc: Doc | null) => void) {
    this.dirs = dirs
    this.onChange = onChange
    mkdirSync(dirs.state, { recursive: true })
    this.#watch()
    // Codex and opencode leave no file behind to watch when they exit, so
    // their records lapse on this instead
    this.#poll = setInterval(() => this.#refresh(), 10_000)
    this.#poll.unref()
    this.#refresh()
  }

  entries(): IterableIterator<[string, Doc]> {
    return this.#current.entries()
  }

  setRoots(roots: Iterable<string>) {
    this.#roots = new Set(roots)
    this.#refresh()
  }

  close() {
    clearTimeout(this.#timer)
    clearInterval(this.#poll)
    for (const w of this.#watchers) w.close()
  }

  #refresh() {
    const records = liveRecords(this.dirs) // newest first
    const next = new Map<string, Doc>()
    for (const root of this.#roots) {
      const record = records.find((r) => r.root === root)
      if (record && isFile(record.file)) next.set(root, { path: record.file })
    }
    for (const root of new Set([...this.#current.keys(), ...next.keys()])) {
      const [before, after] = [this.#current.get(root), next.get(root)]
      if (before?.path === after?.path) continue
      this.onChange(root, after ?? null)
    }
    this.#current = next
  }

  // Claude's session files come and go with the sessions, which decides
  // which of its records count
  #watch() {
    for (const dir of [this.dirs.state, this.dirs.claudeSessions]) {
      try {
        const watcher = watch(dir, () => {
          clearTimeout(this.#timer)
          this.#timer = setTimeout(() => this.#refresh(), 100)
        })
        watcher.on("error", () => {}) // e.g. the dir was removed
        this.#watchers.push(watcher)
      } catch (e) {
        console.error("ah: can't watch dashboard records:", e)
      }
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
