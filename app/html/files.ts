// What the html app keeps live for each open file (host/files/): a watch on
// its directory that tells its pages to reload.

import { type FSWatcher, watch } from "node:fs"
import { dirname } from "node:path"
import {
  type FileApp,
  type Live,
  type OpenFile,
  type Pages,
} from "../../host/files/files.ts"

/** Tells the file's pages to reload when anything in its directory changes:
 * the file itself, or a script, stylesheet or data file next to it */
export class LiveReload implements Live {
  #watcher: FSWatcher
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(path: string, pages: Pages) {
    // The directory rather than the file: most editors save by
    // rename-replace, which makes a watch on the file itself go stale.
    // Dotfiles are editors' and tools' own (swap files, .DS_Store).
    this.#watcher = watch(dirname(path), (_event, filename) => {
      if (filename?.startsWith(".")) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(
        () => pages.broadcast(JSON.stringify({ type: "reload" })),
        100,
      )
    })
    this.#watcher.on("error", (e) => console.error(`ah: can't watch ${path}:`, e))
  }

  close() {
    this.#watcher.close()
    clearTimeout(this.#timer)
  }
}

export const htmlFiles: FileApp<LiveReload> = {
  name: "html",
  title: "HTML",
  attach: async (path, pages) => new LiveReload(path, pages),
}

export type HtmlFile = OpenFile<LiveReload>
