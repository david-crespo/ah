// The file each tab shows in the dashboard, the one its agents set
// (app/sessions/registry.ts), if it's still there.

import { statSync } from "node:fs"
import type { Snapshot } from "../../host/rex.ts"
import type { Registry } from "../sessions/registry.ts"

/** Tab id → file, for the tabs in `ids` */
export function tabFiles(
  snapshot: Snapshot,
  ids: Set<string>,
  registry: Registry,
  isFile: (path: string) => boolean = fileExists,
): Map<string, string> {
  const files = new Map<string, string>()
  for (const tab of snapshot.windows.flatMap((w) => w.tabs)) {
    if (!ids.has(tab.id)) continue
    const path = registry.files.get(tab.id)?.path
    if (path && isFile(path)) files.set(tab.id, path)
  }
  return files
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
