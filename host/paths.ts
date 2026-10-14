// Where ah and the agents it works with keep files. Functions rather than
// constants so tests can point XDG_STATE_HOME somewhere else.

import { homedir } from "node:os"
import { join } from "node:path"

export const stateHome = () =>
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")

export const cacheHome = () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache")

/** ah's own state, under the XDG state dir */
export const ahStateDir = (...parts: string[]) => join(stateHome(), "ah", ...parts)

/** Claude Code's per-process files, <pid>.json, each there only while that
 * process runs */
export const claudeSessionsDir = () => join(homedir(), ".claude", "sessions")
