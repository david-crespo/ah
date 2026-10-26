// A terminal editor in the editor pane's terminal (editor.ts): what the pty
// backend (pty.ts) and the terminal pane (terminal_pane.ts) need from it. Helix
// is the one there is (helix_command.ts on the server, helix.ts in the page).
// The two halves are separate files because the page's half is bundled for
// the browser.

/** The command that opens `file` in the editor. It has to set the editor up
 * to keep to the rules in editor.ts: save soon after typing stops, and take
 * the agent's edits. */
export type TerminalCommand = (file: string) => Promise<{ command: string; args: string[] }>

export interface TerminalEditor {
  /** For the exit notice */
  name: string
  /** ⌘-chords that go to the editor instead of the page, by key, as the
   * bytes to send. xterm doesn't encode ⌘ at all. */
  chords: Record<string, string>
  /** Keys that put the cursor at `line` and `column` (0-based) from any mode,
   * with that line at the top of the view, or as near as the editor goes */
  goto(line: number, column: number): string
  /** Keys that move the view so the cursor's line shows `rows` rows lower,
   * leaving the cursor on it */
  lower(rows: number): string
  /** Rows below the text: status line, command line */
  statusRows: number
  /** The fewest rows the editor keeps between the cursor and the edge of the
   * view */
  scrolloff: number
}
