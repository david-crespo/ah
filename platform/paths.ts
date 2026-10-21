// Where ah and the agents it works with keep files. Functions rather than
// constants so tests can point XDG_STATE_HOME somewhere else.

import { homedir } from "node:os"
import { readdirSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"

export const stateHome = () =>
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")

export const cacheHome = () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache")

/** ah's own state, under the XDG state dir */
export const ahStateDir = (...parts: string[]) => join(stateHome(), "ah", ...parts)

/** Claude Code's per-process files, <pid>.json, each there only while that
 * process runs. Under the config dir the process runs with
 * (CLAUDE_CONFIG_DIR), so sessions under different ones are in different
 * places. */
export const claudeSessionsDir = (configDir = join(homedir(), ".claude")) =>
  join(configDir, "sessions")

/** Claude config dirs by the usual naming: ~/.claude, and ~/.claude-<name>
 * for each other CLAUDE_CONFIG_DIR */
export const claudeConfigDirs = () =>
  readdirSync(homedir())
    .filter((f) => /^\.claude(-.+)?$/.test(f))
    .map((f) => join(homedir(), f))

/** Whether `path` is under `dir` without going through a dot directory
 * (`.git`, `.ssh`) or being a dotfile (`.env`): what pages may load from
 * around them. Both real paths. */
export function plainlyUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== "" && !isAbsolute(rel) && rel.split(sep).every((s) => !s.startsWith("."))
}
