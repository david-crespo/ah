// A file's text as its pages see it: read from disk, watched for changes,
// and pushed to every page showing it. One per open file, from `ah view
// open` until close.
//
// It also keeps an edit window: disk changes since the last
// comment (helix saves, and the agent's own edits echoed back) accumulate
// from the text they started from, and the next comment carries them as one
// splice, so the session's picture of the file stays current without a
// re-read and without being woken for every save.

import { type FSWatcher, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { splice } from "./splice.ts"

export class LiveDoc {
  readonly path: string
  text: string
  #broadcast: (message: string) => void
  #watcher: FSWatcher
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The text before the first unreported change, or null if none */
  #windowBase: string | null = null

  private constructor(path: string, text: string, broadcast: (message: string) => void) {
    this.path = path
    this.text = text
    this.#broadcast = broadcast
    // Watch the parent dir rather than the file: most editors save by
    // rename-replace, which makes a watch on the file itself go stale.
    const name = basename(path)
    this.#watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && filename !== name) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => void this.refresh(), 80)
    })
    this.#watcher.on("error", (e) => console.error(`ah: can't watch ${path}:`, e))
  }

  /** `broadcast` sends the text to the file's pages whenever it changes */
  static async open(
    path: string,
    broadcast: (message: string) => void = () => {},
  ): Promise<LiveDoc> {
    return new LiveDoc(path, await readFile(path, "utf8"), broadcast)
  }

  /** Pick up the file as it is on disk now; the watcher calls this after a
   * change settles, and a comment calls it so its edit notice is current */
  async refresh() {
    let disk: string
    try {
      disk = await readFile(this.path, "utf8")
    } catch {
      return // transiently missing (rename-replace save); next event catches up
    }
    if (disk === this.text) return
    this.#windowBase ??= this.text
    this.text = disk
    this.#broadcast(this.message())
  }

  /** The window's changes as an edit notice for the agent, one line,
   * closing the window; null if nothing changed, or the changes cancel out */
  takeEdit(): string | null {
    const base = this.#windowBase
    this.#windowBase = null
    if (base === null || base === this.text) return null
    const { start, delLen, insert } = splice(base, this.text)
    // Quoted as JSON strings, so newlines in them keep the notice one line
    const quote = (text: string) => JSON.stringify(text.slice(0, 2000))
    const removed = base.slice(start, start + delLen)
    const change = !removed
      ? `inserted ${quote(insert)}`
      : !insert
        ? `deleted ${quote(removed)}`
        : `replaced ${quote(removed)} with ${quote(insert)}`
    const before = base.slice(Math.max(0, start - 40), start)
    const at = before ? ` after ${JSON.stringify(before)}` : " at the start"
    return `Edit notice: since the last request, the file on disk ${change}${at}`
  }

  /** The text as the page takes it, also sent when a page connects */
  message = () => JSON.stringify({ type: "doc", text: this.text })

  close() {
    this.#watcher.close()
    clearTimeout(this.#timer)
  }
}
