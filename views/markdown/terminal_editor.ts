// What the editor pane's terminal (editor.ts) needs from the editor running
// in it, for the pty backend (pty.ts) and the terminal pane
// (terminal_pane.ts). The pane runs Helix (helix_command.ts on the server,
// helix.ts in the page), picked in files.ts and client.ts. Neovim
// (neovim_command.ts, neovim.ts) is an example of another; nothing uses it.
// Each editor's two halves are separate files because the page's half is
// bundled for the browser.

/** The command that opens `file` in the editor. It has to set the editor up
 * to keep to the rules in editor.ts: save soon after typing stops, and reload
 * or merge the agent's edits on disk. */
export type TerminalCommand = (file: string) => Promise<{ command: string; args: string[] }>

export interface TerminalEditor {
  /** Shown in the notice when the editor exits */
  name: string
  /** ⌘-chords that go to the editor instead of the page, by key, as the
   * bytes to send. xterm.js doesn't encode ⌘ chords. */
  chords: Record<string, string>
  /** Keys that put the cursor at `line` and `column` (0-based) from any mode,
   * with that line at the top of the view, or as near as the editor goes */
  goto(line: number, column: number): string
  /** Keys that move the view so the cursor's line shows `rows` rows lower,
   * leaving the cursor on it */
  lower(rows: number): string
  /** Rows below the text (status line, command line) */
  statusRows: number
  /** The fewest rows the editor keeps between the cursor and the top or
   * bottom of the view */
  scrolloff: number
}
