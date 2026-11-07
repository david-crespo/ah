// The version of ah's own state (~/.local/state/ah/, ~/.cache/ah/), and the
// migrations that bring older state up to it. The server runs them when it
// starts, before anything reads state, so pulling a change to how ah keeps
// its files needs nothing from anyone. Each migration checks before it
// moves anything, so it's safe to run twice. docs/upgrading.md has a note
// for each version.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { ahStateDir, cacheHome } from "./paths.ts"

export interface Migration {
  /** The version it brings the state to */
  to: number
  what: string
  run(): void
}

export const MIGRATIONS: Migration[] = [
  {
    to: 1,
    what: "Move the thread logs and the GitHub cache from markdown/ and html/ to doc/ and page/",
    run() {
      moveInto(ahStateDir("markdown"), ahStateDir("doc"))
      moveInto(ahStateDir("html"), ahStateDir("page"))
      moveInto(join(cacheHome(), "ah", "markdown"), join(cacheHome(), "ah", "doc"))
    },
  },
]

export const STATE_VERSION = MIGRATIONS.at(-1)!.to

const versionFile = () => ahStateDir("version")

/** Bring ah's state up to STATE_VERSION, returning what ran. State from
 * before versioning, with no version file, is version 0; with no state at
 * all, there's nothing to migrate. Throws if the state is newer than this
 * code, from a later commit than the one checked out. */
export function upgradeState(migrations = MIGRATIONS): string[] {
  const latest = migrations.at(-1)?.to ?? 0
  const found = readVersion()
  // No file: before versioning, unless there's no state yet
  const version = found ?? (readdir(ahStateDir()).length ? 0 : latest)
  if (version > latest)
    throw new Error(
      `ah: the state in ${ahStateDir()} is version ${version}, newer than this ah's ${latest}. Check out a newer commit of ah; going back isn't supported.`,
    )
  const ran = migrations.filter((m) => m.to > version)
  for (const m of ran) m.run()
  if (found !== latest) {
    mkdirSync(ahStateDir(), { recursive: true })
    writeFileSync(versionFile(), `${latest}\n`)
  }
  return ran.map((m) => `ah: migrated state to version ${m.to}: ${m.what}`)
}

function readVersion(): number | null {
  try {
    return Number(readFileSync(versionFile(), "utf8").trim())
  } catch {
    return null
  }
}

const readdir = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const isDir = (path: string) => statSync(path).isDirectory()

/** Move what's in `from` into `to` and remove `from`, merging directories
 * both have. Where both have a file of the same name, the newer one stays. */
export function moveInto(from: string, to: string) {
  const names = readdir(from)
  if (names.length) mkdirSync(to, { recursive: true })
  for (const name of names) {
    const [src, dest] = [join(from, name), join(to, name)]
    if (!existsSync(dest)) renameSync(src, dest)
    else if (isDir(src) && isDir(dest)) moveInto(src, dest)
    else if (statSync(src).mtimeMs > statSync(dest).mtimeMs) {
      rmSync(dest, { recursive: true, force: true })
      renameSync(src, dest)
    }
  }
  rmSync(from, { recursive: true, force: true })
}
