/// <reference lib="dom" />

// The selection comment popover: select text in a page's content, write a
// note, and it goes into the thread anchored by the selection and up to 60
// characters on each side. Its markup is in page.ts.

import { focusWhenRendered, type Conversation } from "./conversation.ts"

function showToast(msg: string) {
  const toast = document.getElementById("toast")!
  toast.textContent = msg
  toast.style.opacity = "1"
  setTimeout(() => (toast.style.opacity = "0"), 1500)
}

type Captured = {
  selection: string
  prefix: string
  suffix: string
  embed?: string
  rect: DOMRect
  range: Range
}

/** Wire up the page's popover (page.ts) for selections inside `content`;
 * returns what hides it, for the conversation to call when it opens */
export function setUpSelectionComments(
  content: HTMLElement,
  conversation: Conversation,
): () => void {
  const popover = document.getElementById("popover")!
  const commentText = document.getElementById("comment-text") as HTMLTextAreaElement
  // Selection + up to 60 chars of context on each side, for anchoring the
  // comment to the markdown source on the agent side.
  function captureSelection(): Captured | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0).cloneRange()
    // Triple-clicking the last block selects past it, into whatever follows
    // the content (markdown's editor toggle), so keep the part inside
    if (content.contains(range.startContainer) && !content.contains(range.endContainer)) {
      range.setEnd(content, content.childNodes.length)
    }
    if (!content.contains(range.commonAncestorContainer)) return null
    const before = range.cloneRange()
    before.setStart(content, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const after = range.cloneRange()
    after.setEnd(content, content.childNodes.length)
    after.setStart(range.endContainer, range.endOffset)
    // Embedded content (markdown's .gh-embed) has no counterpart in the
    // source; a selection inside one also carries the URL that produced it.
    const anchorEl =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    const embed = anchorEl?.closest<HTMLElement>(".gh-embed")?.dataset.src
    return {
      selection: range.toString(),
      embed,
      prefix: before.toString().slice(-60),
      suffix: after.toString().slice(0, 60),
      rect: range.getBoundingClientRect(),
      range: range.cloneRange(),
    }
  }

  let captured: Captured | null = null
  let selectionSending = false

  function hidePopover() {
    popover.style.display = "none"
    commentText.value = ""
    captured = null
    CSS.highlights.delete("pending-comment")
    conversation.suspendToasts(false)
  }

  // Focusing the comment box clears the browser's native Selection, though the
  // CSS Highlight remains visible. Restore the captured range so the native
  // context menu recognizes selected text and offers actions such as Copy.
  content.addEventListener("contextmenu", (e) => {
    if (!captured || !(e.target instanceof Node) || !content.contains(e.target)) return
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(captured.range.cloneRange())
  })

  document.addEventListener("mouseup", (e) => {
    // A right-click's mouseup fires after the context menu opens. Moving focus
    // to the comment box then clears the selection before Copy can use it.
    if (e.button !== 0) return
    if (popover.contains(e.target as Node)) return
    if (conversation.element.contains(e.target as Node)) return
    if (selectionSending) return
    const cap = captureSelection()
    if (!cap) {
      hidePopover()
      return
    }
    captured = cap
    // Keep the selection visible while the textarea has focus.
    CSS.highlights.set("pending-comment", new Highlight(cap.range))
    popover.style.display = "flex"
    conversation.suspendToasts(true)
    // Shift left when the selection is too close to the viewport's right edge.
    const maxLeft = document.documentElement.clientWidth - popover.offsetWidth - 8
    const left = Math.max(8, Math.min(cap.rect.left, maxLeft))
    popover.style.left = window.scrollX + left + "px"
    popover.style.top = window.scrollY + cap.rect.bottom + 8 + "px"
    focusWhenRendered(commentText)
  })

  async function submit(kind: "comment" | "dellm") {
    if (!captured || selectionSending) return
    const text = commentText.value.trim() || undefined
    if (kind === "comment" && !text) return
    const { selection, prefix, suffix, embed } = captured
    selectionSending = true
    try {
      const result = await conversation.send({
        kind,
        text,
        selection,
        prefix,
        suffix,
        embed,
      })
      hidePopover()
      window.getSelection()?.removeAllRanges()
      showToast(
        result.agentConnected ? "Comment sent" : "Comment saved · no agent connected",
      )
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Could not send comment. Try again.",
      )
    } finally {
      selectionSending = false
    }
  }
  document.getElementById("send")!.addEventListener("click", () => submit("comment"))
  document.getElementById("dellm")!.addEventListener("click", () => submit("dellm"))
  commentText.addEventListener("keydown", (e) => {
    // ctrl+enter for terminal-browser panes, where cmd chords may not arrive
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit("comment")
    if (e.key === "Escape") hidePopover()
  })
  return hidePopover
}
