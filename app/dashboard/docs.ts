// Each agent session's file in the dashboard, usually the tracker note it's
// working from, set with `ah app markdown open --in dashboard`. One record per
// agent in <state>/<key>.json (host/session.ts's `Agent`: the Claude or Codex
// process, which survives /clear or /new, usually followed by /cont on the
// same work; or the opencode session), so writers never race. A record only
// counts while its agent runs, so a stale one can't outlive the session.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { isOneOf, isRecord, isStringOrNull } from "../../host/guards.ts"
import { ahStateDir, claudeSessionsDir } from "../../host/paths.ts"
import { type Agent, agentAlive } from "../../host/session.ts"

export interface ShownFile extends Agent {
  /** The session's workspace, which isn't always the file's: jjw
   * workspaces symlink .claude/notes to the main checkout */
  root: string
  file: string
  since: string
}

export interface Dirs {
  /** Where the records live */
  state: string
  /** Claude's own per-process files, used to tell whether a session is alive */
  claudeSessions: string
}

export function defaultDirs(): Dirs {
  return { state: ahStateDir("sessions"), claudeSessions: claudeSessionsDir() }
}

const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT"

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Nearest ancestor of `dir` (inclusive) that's a jj or git checkout. */
export function repoRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, ".jj")) || exists(join(d, ".git"))) return d
    if (dirname(d) === d) return null
  }
}

/** Every record, with the file it's in; a record from before records named
 * their harness is skipped, and pruned like a dead one */
function records(dirs: Dirs): { record: ShownFile | null; path: string }[] {
  try {
    return readdirSync(dirs.state, { withFileTypes: true })
      .filter((e) => e.name.endsWith(".json"))
      .map((e) => {
        const path = join(dirs.state, e.name)
        return { record: readRecord(path), path }
      })
  } catch (e) {
    if (isNotFound(e)) return []
    throw e
  }
}

function readRecord(path: string): ShownFile | null {
  try {
    const record: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isShownFile(record) ? record : null
  } catch {
    return null
  }
}

function isShownFile(r: unknown): r is ShownFile {
  return (
    isRecord(r) &&
    isOneOf(["claude", "codex", "opencode"] as const, r.harness) &&
    typeof r.key === "string" &&
    (r.pid === null || typeof r.pid === "number") &&
    isStringOrNull(r.sessionId) &&
    typeof r.root === "string" &&
    typeof r.file === "string" &&
    typeof r.since === "string"
  )
}

/** Records of live sessions, newest first. */
export function liveRecords(dirs: Dirs): ShownFile[] {
  return records(dirs)
    .map(({ record }) => record)
    .filter((r): r is ShownFile => r !== null && agentAlive(r, dirs.claudeSessions))
    .sort((a, b) => b.since.localeCompare(a.since))
}

export function writeRecord(dirs: Dirs, record: ShownFile) {
  mkdirSync(dirs.state, { recursive: true })
  for (const { record: r, path } of records(dirs)) {
    if (!r || !agentAlive(r, dirs.claudeSessions)) rmSync(path)
  }
  const tmp = join(dirs.state, `.${record.key}.tmp`)
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n")
  renameSync(tmp, join(dirs.state, `${record.key}.json`))
}

/** The session no longer has a file in the dashboard. */
export function clearSession(dirs: Dirs, key: string) {
  try {
    rmSync(join(dirs.state, `${key}.json`))
  } catch (e) {
    if (!isNotFound(e)) throw e
  }
}

/** Clear `file` from whichever sessions have it. Returns how many did. */
export function clearFile(dirs: Dirs, file: string): number {
  let cleared = 0
  for (const { record, path } of records(dirs)) {
    if (record?.file !== file) continue
    rmSync(path)
    cleared++
  }
  return cleared
}
