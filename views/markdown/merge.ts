// Line-based text merging for an editor pane that runs in the page
// (codemirror_pane.ts), which takes the agent's edits into its unsaved text
// itself. Plain strings in and out, so it's tested without a browser.
//
// It uses node-diff3, which ah doesn't install: see codemirror_pane.ts.

import { diffPatch, merge } from "node-diff3"

/** `disk` merged into `unsaved`, where both are edits of `base`. Overlapping
 * edits are left as git-style conflict markers, labelled as in Helix's fork. */
export function mergeDisk(
  base: string,
  unsaved: string,
  disk: string,
): { text: string; conflict: boolean } {
  const { result, conflict } = merge(
    unsaved.split("\n"),
    base.split("\n"),
    disk.split("\n"),
    { label: { a: "buffer (unsaved)", b: "disk" } },
  )
  return { text: (result as string[]).join("\n"), conflict }
}

type Change = { from: number; to: number; insert: string }

/** The changes that turn `before` into `after`, a run of whole lines each, in
 * order and as offsets into `before`, the way CodeMirror takes them. A
 * reload or merge applied this way leaves a cursor outside them where it
 * was. */
export function lineChanges(before: string, after: string): Change[] {
  const lines = before.split("\n")
  // Where each line starts, and one past the end for a line after the last
  const starts = [0]
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1)
  const end = before.length
  const changes: Change[] = []
  for (const { buffer1: old, buffer2: next } of diffPatch(lines, after.split("\n"))) {
    const from = starts[old.offset]
    const insert = (next.chunk as string[]).join("\n")
    if (old.length && next.length) {
      // Each run ends at a line's end, keeping its newline
      changes.push({ from, to: starts[old.offset + old.length] - 1, insert })
    } else if (next.length) {
      changes.push(
        old.offset < lines.length
          ? { from, to: from, insert: insert + "\n" }
          : { from: end, to: end, insert: "\n" + insert },
      )
    } else if (old.offset + old.length < lines.length) {
      changes.push({ from, to: starts[old.offset + old.length], insert: "" })
    } else {
      // The last lines go with the newline before them
      changes.push({ from: Math.max(0, from - 1), to: end, insert: "" })
    }
  }
  return changes
}
