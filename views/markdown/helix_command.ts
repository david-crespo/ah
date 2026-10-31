// Helix's command for the editor pane's terminal (terminal_editor.ts).
//
// Helix gets a temp config: the user's config.toml (if any) plus auto-save, so
// the preview updates shortly after typing stops. `hx --config` replaces
// config.toml entirely, which is why this concatenates rather than overrides.
// Steel config (helix.scm, init.scm) still loads from the normal location,
// and the agent's edits come in through editors/helix/auto-merge.scm there,
// which the pane's AH_MERGE_URL turns on (files.ts).

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { TerminalCommand } from "./terminal_editor.ts"

const AUTO_SAVE = `
[editor.auto-save]
focus-lost = true

[editor.auto-save.after-delay]
enable = true
timeout = 650
`

let config: Promise<string> | null = null

/** Written once per server, on the first pane; tried again on the next pane
 * if it failed */
function helixConfig(): Promise<string> {
  if (!config) {
    config = (async () => {
      let text = ""
      try {
        text = await readFile(join(homedir(), ".config/helix/config.toml"), "utf8")
      } catch {
        // no user config; the added section alone is fine
      }
      if (!text.includes("[editor.auto-save")) text += AUTO_SAVE
      const path = join(await mkdtemp(join(tmpdir(), "ah-hx-")), "config.toml")
      await writeFile(path, text)
      return path
    })()
    config.catch(() => (config = null))
  }
  return config
}

export const helixCommand: TerminalCommand = async (file) => ({
  command: "hx",
  args: ["--config", await helixConfig(), file],
})
