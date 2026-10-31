// What markdown keeps live for a file while pages show it (subjects/files/):
// the text its pages show (LiveDoc), and any editor panes.

import { threadKinds } from "../../subjects/thread/kinds.ts"
import type { FileType, Live } from "../../subjects/files/files.ts"
import { LiveDoc } from "./doc.ts"
import { helixCommand } from "./helix_command.ts"
import type { EditorBackend } from "./editor.ts"
import { PtyBackend } from "./pty.ts"

export class LiveMarkdown implements Live {
  readonly doc: LiveDoc
  readonly editor: EditorBackend

  constructor(doc: LiveDoc, editor: EditorBackend) {
    this.doc = doc
    this.editor = editor
  }

  /** The edits since the last request, so the agent's picture of the file is
   * current when it reads the request */
  async context() {
    await this.doc.refresh()
    return this.doc.takeEdit()
  }

  close() {
    this.doc.close()
    this.editor.close()
  }
}

/** `port` is the server's, whose merge route (routes.ts) the editor pane's
 * terminal editors call, at AH_MERGE_URL */
export const markdownFiles = (port: number): FileType<LiveMarkdown> => ({
  kind: "markdown",
  kinds: threadKinds,
  attach: async (path, pages) =>
    new LiveMarkdown(
      await LiveDoc.open(path, (message) => pages.broadcast(message)),
      new PtyBackend(path, helixCommand, {
        AH_MERGE_URL: `http://127.0.0.1:${port}/view/markdown/merge`,
      }),
    ),
})
