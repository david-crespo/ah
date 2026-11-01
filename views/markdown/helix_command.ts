// Helix's command for the editor pane's terminal (terminal_editor.ts).
//
// The pane's Helix saves 650ms after typing stops, so the preview keeps up.
// A Helix that takes `--auto-save` (the user's fork, which also lets `hx`
// join a shared session) gets that flag, which turns auto-save on for this
// terminal only, and the user's config as it is. A temp config wouldn't do
// there: if the pane's hx started the session, its config would turn
// auto-save on for every terminal in the session.
//
// Any other Helix gets a temp config: the user's config.toml (if any) plus
// auto-save. `hx --config` replaces config.toml entirely, which is why this
// concatenates rather than overrides.
//
// Steel config (helix.scm, init.scm) loads from the normal location either
// way, and the agent's edits come in through editors/helix/auto-merge.scm
// there, as in any helix.

import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { TerminalCommand } from "./terminal_editor.ts"

const SAVE_AFTER = 650

const AUTO_SAVE = `
[editor.auto-save]
focus-lost = true

[editor.auto-save.after-delay]
enable = true
timeout = ${SAVE_AFTER}
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

let help: Promise<string> | null = null

/** `hx --help`, which exits before loading config or Steel, once per server;
 * tried again on the next pane if it failed */
function helixHelp(): Promise<string> {
  if (!help) {
    help = promisify(execFile)("hx", ["--help"]).then((r) => r.stdout)
    help.catch(() => (help = null))
  }
  return help
}

/** hx's arguments to open `file`, for the hx whose `--help` printed `help` */
export async function helixArgs(help: string, file: string): Promise<string[]> {
  return /\s--auto-save\b/.test(help)
    ? ["--auto-save", String(SAVE_AFTER), file]
    : ["--config", await helixConfig(), file]
}

export const helixCommand: TerminalCommand = async (file) => ({
  command: "hx",
  // Without hx, it fails to start either way
  args: await helixArgs(await helixHelp().catch(() => ""), file),
})
