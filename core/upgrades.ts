// Files in people's repos that use an old ah format, such as a tracker page
// that loads a script from a path ah no longer serves. Agents write them,
// so no script can be sure of the edit, and ah never changes them: it finds
// them, a starting agent in their workspace hears about them (core.ts), and
// `ah doctor` lists them with what to change, for an agent to do and check.
// Each format change is a FileUpgrade, defined by the view whose files it's
// about. ah's own state is another matter (platform/state_version.ts).
//
// ah doesn't scan the disk. It checks the trackers it has records of when
// the server starts, and every page as it serves it. What it found is in
// memory, so a restart finds the trackers again and the rest as they're
// served. Which workspace a file is in is the core's to say: a tracker in
// a secondary jj workspace is often a file of the default one, through a
// linked .claude/notes.

import { readFileSync } from "node:fs"

export interface FileUpgrade {
  /** What changed: one line */
  what: string
  /** Whether a file's text needs it */
  needs(text: string): boolean
  /** What to change in a file that needs it, for the agent making the edit */
  how: string
}

export interface Outdated {
  path: string
  what: string
  how: string
}

export class Upgrades {
  #upgrades: FileUpgrade[]
  /** By path: the upgrades it needs */
  #found = new Map<string, FileUpgrade[]>()

  constructor(upgrades: FileUpgrade[]) {
    this.#upgrades = upgrades
  }

  /** Note whether the file at `path`, whose text is `text`, needs any */
  check(path: string, text: string) {
    const needed = this.#upgrades.filter((u) => u.needs(text))
    if (needed.length) this.#found.set(path, needed)
    else this.#found.delete(path)
  }

  /** Check the files at `paths` as they are on disk, forgetting any gone */
  scan(paths: Iterable<string>) {
    for (const path of paths) {
      let text: string
      try {
        text = readFileSync(path, "utf8")
      } catch {
        this.#found.delete(path)
        continue
      }
      this.check(path, text)
    }
  }

  /** The files found, checked again first, since an agent may have fixed
   * them since */
  outdated(): Outdated[] {
    this.scan([...this.#found.keys()])
    return [...this.#found].flatMap(([path, needed]) =>
      needed.map(({ what, how }) => ({ path, what, how })),
    )
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The line a starting agent gets about files in its workspace that use an
 * old format and problems with ah's setup, or null if there are none */
export function doctorNotice(outdated: Outdated[], problems: number): string | null {
  const files = new Set(outdated.map((o) => o.path)).size
  const found = [
    files &&
      `${count(files, "file in this workspace that uses", "files in this workspace that use")} an old ah format`,
    problems &&
      count(problems, "problem with how ah is set up", "problems with how ah is set up"),
  ].filter(Boolean)
  if (!found.length) return null
  return `ah: \`ah doctor\` finds ${found.join(" and ")}. Run it, as the whole Bash command so it runs outside the sandbox, to see what to change, then tell the user and offer to make the changes. Don't make them unasked.`
}
