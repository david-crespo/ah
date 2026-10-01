// A workspace's jj log, rerendered whenever an operation lands. New operations
// rewrite the op heads dir, the same trigger `jj watch` uses.

import { realpathSync, watch, type FSWatcher } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { run } from "../../host/proc.ts"
import { ansiToHtml } from "./ansi.ts"

/**
 * In the default workspace `.jj/repo` is the repo dir; in a secondary
 * workspace it's a file holding the repo dir's path, relative to `.jj`.
 */
export async function opHeadsDir(root: string): Promise<string> {
  const dotJj = join(root, ".jj")
  const repo = join(dotJj, "repo")
  const st = await stat(repo)
  const repoDir = st.isFile() ? resolve(dotJj, (await readFile(repo, "utf8")).trim()) : repo
  return join(repoDir, "op_heads", "heads")
}

// The log's default revset can reach far back in a busy repo
const LOG_LIMIT = "50"

async function renderLog(root: string): Promise<string> {
  const { success, stdout, stderr } = await run(
    "jj",
    [
      "--ignore-working-copy",
      "--color",
      "always",
      "log",
      "--limit",
      LOG_LIMIT,
      "--template",
      "home",
    ],
    { cwd: root },
  )
  // a failure (e.g. a stale workspace) shows jj's own message in the pane
  return ansiToHtml(success ? stdout : stderr)
}

/**
 * Calls `onChange` with the log's HTML on start and after every operation
 * that changes it. At most one render runs at a time; changes that land
 * during a render trigger one more.
 */
export class LogWatcher {
  #watcher: FSWatcher | null = null
  #running = false
  #dirty = false
  #html: string | null = null
  #closed = false

  readonly root: string
  readonly onChange: (html: string) => void

  constructor(root: string, onChange: (html: string) => void) {
    this.root = root
    this.onChange = onChange
    this.#render()
    this.#watch().catch((e) => console.error(`ah: can't watch ${root}:`, e))
  }

  get html() {
    return this.#html
  }

  async #watch() {
    const dir = await opHeadsDir(this.root)
    if (this.#closed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    this.#watcher = watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(() => this.#render(), 30)
    })
    this.#watcher.on("error", (e) => console.error(`ah: can't watch ${this.root}:`, e))
  }

  async #render() {
    if (this.#running) {
      this.#dirty = true
      return
    }
    this.#running = true
    try {
      do {
        this.#dirty = false
        const html = await renderLog(this.root).catch((e) => ansiToHtml(String(e)))
        if (!this.#closed && html !== this.#html) {
          this.#html = html
          this.onChange(html)
        }
      } while (this.#dirty && !this.#closed)
    } finally {
      this.#running = false
    }
  }

  close() {
    this.#closed = true
    this.#watcher?.close()
  }
}

// Edits under these never change what jj snapshots (jj's own state, build
// output), and a cargo or npm build would otherwise keep resetting the timer.
const IGNORED_DIRS = new Set([".jj", ".git", "target", "node_modules"])

/** `path` is relative to the watched root, as fs.watch reports it */
export function isIgnored(path: string): boolean {
  return path.split(sep).some((segment) => IGNORED_DIRS.has(segment))
}

/**
 * Runs `jj util snapshot` once files in the workspace have been quiet for
 * `delayMs`, so `@` in the log reflects edits that no jj command has seen
 * yet. jj records an operation only when something changed, which then
 * fires the LogWatcher. Any jj command would take the same snapshot; this
 * only takes it sooner.
 */
export class SnapshotWatcher {
  #watcher: FSWatcher | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  readonly root: string
  readonly delayMs: number

  constructor(root: string, delayMs: number) {
    this.root = root
    this.delayMs = delayMs
    const onChange = (filename: string | null) => {
      if (filename && isIgnored(filename)) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => this.#snapshot(), this.delayMs)
    }
    try {
      // Gone if the workspace was removed while a tab was still in it
      this.#watcher = watch(realpathSync(root), { recursive: true }, (_e, f) => onChange(f))
    } catch (e) {
      console.error(`ah: can't watch files in ${root}:`, e)
      return
    }
    this.#watcher.on("error", (e) => console.error(`ah: can't watch files in ${root}:`, e))
  }

  async #snapshot() {
    const { success, stderr } = await run("jj", ["util", "snapshot"], { cwd: this.root })
    if (!success) console.error(`ah: snapshot in ${this.root} failed:`, stderr)
  }

  close() {
    clearTimeout(this.#timer)
    this.#watcher?.close()
  }
}
