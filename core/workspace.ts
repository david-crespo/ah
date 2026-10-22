// Which jj workspace a directory or a tab is in. A workspace is known by
// its root, the directory holding `.jj`.

import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Tab, WorkspaceRoot } from "./model.ts"

export type RootOf = (dir: string) => WorkspaceRoot | null

/** Nearest ancestor of `dir` (inclusive) containing `.jj`, cached by dir for
 * the finder's lifetime, so make one per RexState */
export function rootFinder(): RootOf {
  const cache = new Map<string, string | null>()
  const isWorkspace = (dir: string) => {
    try {
      return statSync(join(dir, ".jj")).isDirectory()
    } catch {
      return false
    }
  }
  const find = (dir: string): string | null => {
    if (!dir.startsWith("/")) return null
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const parent = dirname(dir)
    const root = isWorkspace(dir) ? dir : parent === dir ? null : find(parent)
    cache.set(dir, root)
    return root
  }
  return find
}

/** Whether `path` (real) is one `ah view open` may serve from `cwd`: under
 * cwd, the jj workspace it's in, or that repo's default workspace, where a
 * secondary workspace's notes usually are. ah runs outside the agent's
 * sandbox, so without this an agent talked into opening ~/.ssh/id_ed25519
 * would serve it to the pages. */
export function openable(path: string, cwd: string): boolean {
  const real = realpathSync(cwd)
  const root = rootFinder()(real)
  const dirs = [real, root, root && defaultWorkspace(root)]
  return dirs.some((dir) => dir && path.startsWith(dir + "/"))
}

/** The default workspace of the repo `root` is a workspace of. A secondary
 * workspace's `.jj/repo` is a file holding the path of the default one's
 * `.jj/repo` dir, relative to `.jj`. */
function defaultWorkspace(root: string): string | null {
  const dotJj = join(root, ".jj")
  try {
    const pointer = readFileSync(join(dotJj, "repo"), "utf8").trim()
    return dirname(dirname(realpathSync(resolve(dotJj, pointer))))
  } catch {
    // a directory (this is the default workspace) or no repo at all
    return null
  }
}

/**
 * The workspace most of a tab's blocks are in. Going by the focused
 * block alone isn't reliable: a pane can report a stale directory (a
 * block-browser pane reports its temp dir), so it only breaks ties.
 */
export function tabRoot(tab: Tab, rootOf: RootOf): WorkspaceRoot | null {
  const counts = new Map<string, number>()
  for (const t of tab.blocks) {
    const root = rootOf(t.cwd)
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  const max = Math.max(0, ...counts.values())
  const tied = [...counts].filter(([, n]) => n === max).map(([root]) => root)
  if (tied.length <= 1) return tied[0] ?? null
  const focused = tab.blocks.find((t) => t.id === tab.focused)
  const focusedRoot = focused && rootOf(focused.cwd)
  return focusedRoot && tied.includes(focusedRoot) ? focusedRoot : tied[0]
}
