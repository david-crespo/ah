// Helix's command for the editor pane's terminal (terminal_editor.ts).
//
// Helix gets a temp config: the user's config.toml (if any) plus auto-save, so
// the preview updates shortly after typing stops, and auto-reload, so the pane
// picks up the agent's edits to the file instead of going stale. `hx --config`
// replaces config.toml entirely, which is why this concatenates rather than
// overrides. Steel config (init.scm) still loads from the normal location.
//
// auto-reload is not upstream helix: it's the `auto-reload` branch of the
// user's fork (a port of helix-editor/helix#13963 that reloads unmodified
// buffers silently). With `merge`, buffers with unsaved edits get a three-way
// merge of disk into the buffer; overlapping edits are left as conflict
// markers to resolve in place. Upstream helix rejects the unknown section.

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

const AUTO_RELOAD = `
[editor.auto-reload]
focus-gained = true
merge = true

[editor.auto-reload.periodic]
enable = true
interval = 300
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
        // no user config; the added sections alone are fine
      }
      if (!text.includes("[editor.auto-save")) text += AUTO_SAVE
      if (!text.includes("[editor.auto-reload")) text += AUTO_RELOAD
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
