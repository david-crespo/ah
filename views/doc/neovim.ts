// The page's half of Neovim as a terminal editor (terminal_editor.ts), with
// its name and keys. The server's half is neovim_command.ts. Nothing uses
// either; see there.

import type { TerminalEditor } from "./terminal_editor.ts"

/** Ctrl-\ Ctrl-N: back to normal mode from insert, visual or command-line
 * mode */
const NORMAL = "\x1c\x0e"

export const neovim: TerminalEditor = {
  name: "neovim",
  // ⌘S as a kitty keyboard protocol super chord, which Neovim reads as <D-s>
  // and neovim_command.ts maps to a save
  chords: { s: `\x1b[${"s".codePointAt(0)};9u` },
  // G for the line, a count of l for the column, and zt to put the line at
  // the top of the view
  goto: (line, column) => `${NORMAL}${line + 1}G0${column ? `${column}l` : ""}zt`,
  // Each Ctrl-Y scrolls the view down a row and leaves the cursor on its line
  lower: (rows) => "\x19".repeat(rows),
  statusRows: 2,
  // Neovim's default
  scrolloff: 0,
}
