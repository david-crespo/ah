// What html keeps live for a file while pages show it (subjects/files/): a
// watch on its directory, and on what page apps watch (app.ts), that tells
// its pages to reload, or an app's page to read its data again.

import { type FSWatcher, watch } from "node:fs"
import { dirname } from "node:path"
import type { FileType, Live, Pages } from "../../subjects/files/files.ts"
import type { AppWatch, PageApp } from "./app.ts"
import { pageKinds } from "./requests.ts"

/** Tells the file's pages to reload when anything in its directory changes:
 * the file itself, or a script, stylesheet or data file next to it. A page
 * of one of `apps` draws its data itself, so it's only told that the data
 * changed: a change in what the app watches for it, or to one of its data
 * files. */
export class LiveReload implements Live {
  #watchers: FSWatcher[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(path: string, pages: Pages, apps: PageApp[] = []) {
    let reload = false
    const changed = (type: "reload" | "data") => {
      reload ||= type === "reload"
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        pages.broadcast(JSON.stringify({ type: reload ? "reload" : "data" }))
        reload = false
      }, 100)
    }
    const watches: AppWatch[] = []
    // The directory rather than the file: most editors save by
    // rename-replace, which makes a watch on the file itself go stale.
    // Dotfiles are editors' and tools' own (swap files, .DS_Store).
    this.#watch(path, dirname(path), (filename) => {
      if (filename?.startsWith(".")) return
      const data = filename !== null && watches.some((w) => w.data(filename))
      changed(data ? "data" : "reload")
    })
    for (const app of apps) {
      app
        .watch?.(path)
        .then((w) => {
          if (!w || this.#closed) return
          watches.push(w)
          for (const dir of w.dirs) this.#watch(path, dir, () => changed("data"))
        })
        // As for a stack in a secondary workspace whose repo is gone
        .catch((e) => console.error(`ah: can't watch ${path}'s data:`, e))
    }
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

export const pageFiles = (apps: PageApp[]): FileType<LiveReload> => ({
  kind: "page",
  skill: "ah-page",
  // Any page can be a task list: it says so by loading task_list.js
  kinds: pageKinds,
  attach: async (path, pages) => new LiveReload(path, pages, apps),
})
