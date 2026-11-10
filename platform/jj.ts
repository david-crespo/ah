// Running jj for ah's reads, and where a jj repo keeps itself: its repo dir,
// and the op heads views watch to redraw when an operation lands

import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { run } from "./proc.ts"

/** jj's output in `cwd`, uncolored and without snapshotting the working copy:
 * a read shouldn't take its lock. Throws jj's complaint. */
export async function jj(cwd: string, ...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await run(
    "jj",
    ["--ignore-working-copy", "--color=never", ...args],
    { cwd },
  )
  if (!success) throw new Error(stderr.trim())
  return stdout
}

/**
 * The repo dir of the workspace at `root`. In the default workspace
 * `.jj/repo` is the repo dir; in a secondary workspace it's a file holding
 * the repo dir's path, relative to `.jj`. Throws if `root` has neither.
 */
export function repoDir(root: string): string {
  const dotJj = join(root, ".jj")
  const repo = join(dotJj, "repo")
  return statSync(repo).isFile() ? resolve(dotJj, readFileSync(repo, "utf8").trim()) : repo
}

/** The op heads dir, which every new operation rewrites, the same trigger
 * `jj watch` uses */
export async function opHeadsDir(root: string): Promise<string> {
  return join(repoDir(root), "op_heads", "heads")
}
