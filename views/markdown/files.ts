// What markdown keeps live for each open file (subjects/files/): the text
// its pages show (LiveDoc), and any helix panes.

import { threadKinds } from "../../subjects/thread/kinds.ts"
import type { FileType, Live, OpenFile } from "../../subjects/files/files.ts"
import { LiveDoc } from "./doc.ts"
import { HelixPanes } from "./helix.ts"

export class LiveMarkdown implements Live {
  readonly doc: LiveDoc
  readonly helix: HelixPanes

  constructor(doc: LiveDoc, helix: HelixPanes) {
    this.doc = doc
    this.helix = helix
  }

  /** The edits since the last request, so the agent's picture of the file is
   * current when it reads the request */
  async context() {
    await this.doc.refresh()
    return this.doc.takeEdit()
  }

  close() {
    this.doc.close()
    this.helix.close()
  }
}

export const markdownFiles: FileType<LiveMarkdown> = {
  kind: "markdown",
  kinds: threadKinds,
  attach: async (path, pages) =>
    new LiveMarkdown(
      await LiveDoc.open(path, (message) => pages.broadcast(message)),
      new HelixPanes(path),
    ),
}

export type MarkdownFile = OpenFile<LiveMarkdown>
