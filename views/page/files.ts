// What html keeps live for a file while pages show it (subjects/files/): a
// watch on its directory, and on a stack's repo, that tells its pages to
// reload.

import { type FSWatcher, watch } from "node:fs"
import { dirname } from "node:path"
import type { FileType, Live, Pages } from "../../subjects/files/files.ts"
import { pageKinds } from "./requests.ts"
import { stackOpsDir } from "./stack_data.ts"

/** Tells the file's pages to reload when anything in its directory changes:
 * the file itself, or a script, stylesheet or data file next to it; and for
 * a stack's page, which shows the repo's commits, when a jj operation lands */
export class LiveReload implements Live {
  #watchers: FSWatcher[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(path: string, pages: Pages) {
    const reload = () => {
      clearTimeout(this.#timer)
      this.#timer = setTimeout(
        () => pages.broadcast(JSON.stringify({ type: "reload" })),
        100,
      )
    }
    // The directory rather than the file: most editors save by
    // rename-replace, which makes a watch on the file itself go stale.
    // Dotfiles are editors' and tools' own (swap files, .DS_Store).
    this.#watch(path, dirname(path), (filename) => {
      if (!filename?.startsWith(".")) reload()
    })
    void stackOpsDir(path).then((dir) => {
      if (dir && !this.#closed) this.#watch(path, dir, reload)
    })
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
