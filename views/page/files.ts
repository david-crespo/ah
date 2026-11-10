// What html keeps live for a file while pages show it (subjects/files/): a
// watch on its directory, and on a stack's repo, that tells its pages to
// reload, or a stack's page to read its data again.

import { type FSWatcher, watch } from "node:fs"
import { dirname } from "node:path"
import type { FileType, Live, Pages } from "../../subjects/files/files.ts"
import { pageKinds } from "./requests.ts"
import { STACK_FILE, stackOpsDir } from "./stack_data.ts"

/** Tells the file's pages to reload when anything in its directory changes:
 * the file itself, or a script, stylesheet or data file next to it. A
 * stack's page draws its data itself (stack.ts), so it's only told that the
 * data changed: its stack.json, a PR's body, or the repo's commits, when a
 * jj operation lands. */
export class LiveReload implements Live {
  #watchers: FSWatcher[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(path: string, pages: Pages) {
    let reload = false
    const changed = (type: "reload" | "data") => {
      reload ||= type === "reload"
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        pages.broadcast(JSON.stringify({ type: reload ? "reload" : "data" }))
        reload = false
      }, 100)
    }
    let stack = false
    // The directory rather than the file: most editors save by
    // rename-replace, which makes a watch on the file itself go stale.
    // Dotfiles are editors' and tools' own (swap files, .DS_Store).
    this.#watch(path, dirname(path), (filename) => {
      if (filename?.startsWith(".")) return
      const data = stack && (filename === STACK_FILE || filename?.endsWith(".md"))
      changed(data ? "data" : "reload")
    })
    // watch throws for a secondary workspace whose repo is gone
    stackOpsDir(path)
      .then((dir) => {
        if (!dir || this.#closed) return
        stack = true
        this.#watch(path, dir, () => changed("data"))
      })
      .catch((e) => console.error(`ah: can't watch ${path}'s repo:`, e))
  }

  #watch(path: string, dir: string, onChange: (filename: string | null) => void) {
    const watcher = watch(dir, (_event, filename) => onChange(filename))
    watcher.on("error", (e) => console.error(`ah: can't watch ${path}:`, e))
    this.#watchers.push(watcher)
  }

  close() {
    this.#closed = true
    for (const w of this.#watchers) w.close()
    clearTimeout(this.#timer)
  }
}

export const pageFiles: FileType<LiveReload> = {
  kind: "page",
  skill: "ah-page",
  // Any page can be a task list: it says so by loading task_list.js
  kinds: pageKinds,
  attach: async (path, pages) => new LiveReload(path, pages),
}
