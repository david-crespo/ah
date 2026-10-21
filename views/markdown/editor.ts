// The file page's editor pane, next to the preview. There's no setting to
// pick the editor; these interfaces are where one goes. There are two levels:
//
// - What fills the pane, here: an EditorBackend on the server, one per open
//   file, and an EditorPane in the page. The backend gets every socket the
//   pane opens, at <id>/editor, and the two speak whatever protocol they
//   like on it. One pair is a terminal (pty.ts and terminal_pane.ts). The
//   other is CodeMirror, running in the page (codemirror_backend.ts and
//   codemirror_pane.ts), an example that nothing uses.
// - Which editor runs in that terminal: terminal_editor.ts, with Helix
//   (helix.ts and helix_command.ts) as the one in use and Neovim as an
//   example.
//
// Both are chosen in files.ts (the backend) and client.ts (the pane).
//
// Whatever the editor, the file on disk is the source of truth: the preview
// shows it, and the agent edits it directly. So an editor has to:
//
// - Save soon after typing stops, since the preview follows the file.
// - Never write over a version of the file newer than the one it last loaded
//   or saved, which may be the agent's edit.
// - Take the agent's edits: reload when nothing is unsaved, and otherwise
//   merge the file on disk into the unsaved text. Helix's fork and the
//   CodeMirror pane do a three-way merge against the last save and leave
//   overlaps as conflict markers, which the preview renders.
//
// A page-side editor has the file's text already: the doc socket pushes it on
// every change (doc.ts), and the preview element holds it (preview.ts).
//
// Comments from the editor to an agent are separate. The preview's selection
// comments work with any editor, and Helix's own are Steel commands in
// editors/helix/ that run `ah message send`.

import type { WebSocket } from "ws"

/** The server side, for one file: every socket the pane opens, until the
 * file closes */
export interface EditorBackend {
  connect(ws: WebSocket, query: URLSearchParams): void | Promise<void>
  close(): void
}

/** The page side, in the pane's element, talking to its backend over the
 * socket URL it's made with. The pane starts hidden; hiding it again is the
 * page's business (`editor-shown` on the body). */
export interface EditorPane {
  /** The pane was shown: start the editor if it isn't running, else focus it */
  show(): void
  /** Put the cursor at `line` and `column` (0-based) for ⌘-click in the
   * preview, with that line level with `y` (client coordinates) if the editor
   * can scroll it there. Called after `show`. */
  reveal(line: number, column: number, y: number): Promise<void>
}
