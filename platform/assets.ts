// Files the server reads at runtime (pages, stylesheets, client bundles),
// found relative to the package root. Running from source, modules sit at
// various depths under it; in the published package everything is bundled
// into dist/ah.js. package.json is at the root either way.

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

function findRoot(dir: string): string {
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error("ah: can't find the package root")
    dir = parent
  }
  return dir
}

export const packageRoot = findRoot(import.meta.dirname)

/** `path` relative to the package root, e.g. "views/dashboard/page.html" */
export const assetPath = (path: string) => join(packageRoot, path)
