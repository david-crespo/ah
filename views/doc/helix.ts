// Helix as the editor pane's terminal editor, page side (terminal_editor.ts):
// its keys and name. The server's half, its command and config, is
// helix_command.ts.
//
// Keys that would be ambiguous as raw bytes go as kitty keyboard protocol
// keys, which helix parses without negotiating the protocol: ⌘-chords as
// super chords (CSI codepoint;9u), and escape as CSI 27u, since a bare ESC
// with more keys after it in one read is Alt plus the next key.

import type { TerminalEditor } from "./terminal_editor.ts"

const ESCAPE = "\x1b[27u"

/** ⌘-chords the user's helix config binds: write, and extend the selection by
 * a line up or down */
const CHORD_KEYS = ["s", "j", "k"]

export const helix: TerminalEditor = {
  name: "helix",
  chords: Object.fromEntries(
    CHORD_KEYS.map((key) => [key, `\x1b[${key.codePointAt(0)};9u`]),
  ),
  // Escape to normal mode from insert mode, a prompt or a picker, then
  // `:goto`, a count of `l` for the column, and `zt`, which leaves the cursor
  // `scrolloff` rows from the top (or lower near the file's start, where the
  // view can't scroll up)
  goto: (line, column) => `${ESCAPE}:goto ${line + 1}\r${column ? `${column}l` : ""}zt`,
  // Each k in sticky view mode (Z) scrolls the view up a row and so moves the
  // cursor down one, which it can do until it's `scrolloff` rows from the
  // bottom of the text area
  lower: (rows) => `Z${"k".repeat(rows)}${ESCAPE}`,
  statusRows: 2,
  // helix's default; a bigger one would move the cursor off its line near the
  // bottom of the view
  scrolloff: 5,
}
