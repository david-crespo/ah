/// <reference lib="dom" />

// Browser half of ah's markdown file page, served as /view/markdown/bundle.js
// (see platform/bundle.ts). The preview itself is the <ah-markdown>
// element (preview.ts); this adds what only the file page has: the editor in a
// collapsible pane (editor.ts), the thread's conversation and
// selection comment popover (views/thread/), and ⌘F's find bar (find.ts).
// The page leaves out the editor pane with ?editor=off and the chat with
// ?chat=off.

import { Conversation } from "../thread/conversation.ts"
import { threadKinds } from "../../subjects/thread/kinds.ts"
import { setUpSelectionComments } from "../thread/selection.ts"
import { setUpFind } from "./find.ts"
import "./preview.ts"
import { type SourcePosition, sourcePosition } from "./source_position.ts"
import type { EditorPane } from "./editor.ts"
import { helix } from "./helix.ts"
import { TerminalPane } from "./terminal_pane.ts"

const preview = document.querySelector("ah-markdown")!
const content = preview.content
const editorHost = document.getElementById("editor-host")
const editorToggle = document.getElementById("editor-toggle")
// Selection comments go through the conversation, so both are only there
// with chat on
const chat = document.getElementById("popover") !== null
let hidePopover = () => {}
const conversation = chat ? new Conversation(() => hidePopover(), threadKinds) : null
if (conversation) hidePopover = setUpSelectionComments(content, conversation)
setUpFind(content)

/** A WebSocket URL relative to the file's page */
function wsUrl(path: string): string {
  const url = new URL(path, location.href)
  url.protocol = "ws:"
  return url.href
}

// The doc socket also carries the thread
preview.addEventListener("doc-message", (e) => {
  const msg = e.detail
  if (msg.type === "thread") conversation?.receive(msg, msg.replay)
})
preview.addEventListener("doc-close", () => conversation?.setConnected(false))
// ranges are stale after re-render
preview.addEventListener("render", () => CSS.highlights.delete("pending-comment"))

// Browsers only let a script close windows that a script opened, or ones
// with a single history entry, so this may do nothing; the preview says it's
// closed either way.
preview.addEventListener("closed", () => {
  window.close()
  document.title = `${document.title} (closed)`
})

// ---------- editor pane ----------

// What fills the pane (editor.ts): Helix in a terminal. The pane always
// starts collapsed.
const pane: EditorPane | null = editorHost
  ? new TerminalPane(editorHost, wsUrl("editor"), helix)
  : null

function setEditorShown(shown: boolean) {
  if (!pane) return
  document.body.classList.toggle("editor-shown", shown)
  if (shown) pane.show()
}

if (editorHost && editorToggle) {
  editorToggle.addEventListener("click", () => {
    setEditorShown(!document.body.classList.contains("editor-shown"))
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "e" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      setEditorShown(!document.body.classList.contains("editor-shown"))
    }
  })
  content.addEventListener("click", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const target = e.target as Element
    // ⌘-click on a link still opens it
    if (target.closest("a")) return
    const block = target.closest<HTMLElement>("[data-line]")
    const text = preview.text
    if (!block || !content.contains(block) || text === null) return
    e.preventDefault()
    const [start, end] = block.dataset.line!.split(":").map(Number)
    let caret = caretAt(e.clientX, e.clientY)
    if (caret && !block.contains(caret.node)) caret = null
    let before = ""
    const spot = document.createRange()
    if (caret) {
      const upTo = document.createRange()
      upTo.setStart(block, 0)
      upTo.setEnd(caret.node, caret.offset)
      before = upTo.toString()
      spot.setStart(caret.node, caret.offset)
      // The character after the caret, since a collapsed range may have no
      // box to measure
      if (caret.node instanceof Text && caret.offset < caret.node.length)
        spot.setEnd(caret.node, caret.offset + 1)
    } else spot.selectNodeContents(block)
    void showInEditor(sourcePosition(text.split("\n"), start, end, before), spot)
  })
}

/** The caret position at (x, y) */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(x, y)
    return caret && { node: caret.offsetNode, offset: caret.offset }
  }
  // WebKit before Safari 26 has only the older one
  const range = document.caretRangeFromPoint(x, y)
  return range && { node: range.startContainer, offset: range.startOffset }
}

/** The middle of the first line `range` is on, in client coordinates */
function middleOf(range: Range): number {
  const box = range.getClientRects()[0] ?? range.getBoundingClientRect()
  return box.top + box.height / 2
}

/** Show the editor at `line` and `column`, level with `spot`, the place in the
 * preview it came from. The preview stays put, since that's where the user
 * clicked. */
async function showInEditor({ line, column }: SourcePosition, spot: Range) {
  const shown = document.body.classList.contains("editor-shown")
  const y = middleOf(spot)
  setEditorShown(true)
  // The preview narrows and reflows; keep the spot where it was clicked
  if (!shown) window.scrollBy(0, middleOf(spot) - y)
  await pane?.reveal(line, column, middleOf(spot))
}

// ? shows the page's shortcuts (page.ts), unless it's being typed somewhere:
// the comment and chat boxes, or the editor, whose xterm takes keys in a
// textarea
const shortcuts = document.getElementById("shortcuts") as HTMLDialogElement
document.addEventListener("keydown", (e) => {
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement
  if (target.closest("input, textarea, select, [contenteditable]")) return
  e.preventDefault()
  if (shortcuts.open) shortcuts.close()
  else shortcuts.showModal()
})

// ⇧⌘C copies the file's path, from anywhere on the page: the editor pane
// passes it on with the other ⌘-chords the editor doesn't bind. (Not VS Code's
// ⌥⌘C, which Alfred takes for its clipboard.) In a Chrome tab, DevTools'
// element picker may get it first.
const copied = document.getElementById("copied")!
let copiedTimer = 0
async function copyPath() {
  const path = document.body.dataset.path ?? ""
  try {
    await navigator.clipboard.writeText(path)
    copied.textContent = `Copied ${path}`
  } catch {
    copied.textContent = "Couldn't copy the path"
  }
  copied.classList.add("shown")
  clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => copied.classList.remove("shown"), 1500)
}
document.addEventListener("keydown", (e) => {
  if (e.code === "KeyC" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    void copyPath()
  }
})
