// Where a jj repo records its operations, for views that redraw when one lands

import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * The op heads dir, which every new operation rewrites, the same trigger
 * `jj watch` uses. In the default workspace `.jj/repo` is the repo dir; in a
 * secondary workspace it's a file holding the repo dir's path, relative to
 * `.jj`.
 */
export async function opHeadsDir(root: string): Promise<string> {
  const dotJj = join(root, ".jj")
  const repo = join(dotJj, "repo")
  const st = await stat(repo)
  const repoDir = st.isFile() ? resolve(dotJj, (await readFile(repo, "utf8")).trim()) : repo
  return join(repoDir, "op_heads", "heads")
}
