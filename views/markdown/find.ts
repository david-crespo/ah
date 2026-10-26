/// <reference lib="dom" />

// ⌘F's find bar (#find in page.ts), over the rendered preview only: the
// helix pane, the chat and the rest of the page aren't searched. Matches are
// marked by boxes in an overlay (#find-marks) at their text's client rects,
// so the preview's DOM, which selection comments anchor on, stays as
// rendered. (Not CSS custom highlights: WebKit paints their background the
// full height of the line, so matches on neighboring lines run together.)
// While the bar is open, any change to the preview (a re-render, code
// highlighting, a diagram) searches again, and a change to its layout draws
// the marks again.

/** A match's start and end, each as [index into the texts, offset in it] */
export type Match = { start: [number, number]; end: [number, number] }

/** Where `query` occurs in `texts`, a run of text nodes' contents read as one
 * string. Case-insensitive, and whitespace in the query matches any run of
 * whitespace, since the preview reflows hard-wrapped source lines. */
export function findMatches(texts: string[], query: string): Match[] {
  if (!query.trim()) return []
  const pattern = query
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+")
  const text = texts.join("")
  const matches: Match[] = []
  // The text that holds offset `at`; `end` takes a node's end over the next
  // one's start
  let node = 0
  let nodeStart = 0
  const locate = (at: number, end: boolean): [number, number] => {
    while (
      node < texts.length - 1 &&
      (end ? at > nodeStart + texts[node].length : at >= nodeStart + texts[node].length)
    ) {
      nodeStart += texts[node].length
      node++
    }
    return [node, at - nodeStart]
  }
  for (const m of text.matchAll(new RegExp(pattern, "giu"))) {
    const start = locate(m.index, false)
    matches.push({ start, end: locate(m.index + m[0].length, true) })
  }
  return matches
}

/** Wire up the page's find bar for `content`, the preview's rendered file */
export function setUpFind(content: HTMLElement) {
  const bar = document.getElementById("find")!
  const input = bar.querySelector("input")!
  const count = document.getElementById("find-count")!
  const marks = document.getElementById("find-marks")!
  let ranges: Range[] = []
  let current = 0
  /** Where focus was before the bar opened, to go back to on close */
  let returnFocus: Element | null = null
  const observer = new MutationObserver(() => {
    search()
    current = Math.min(current, Math.max(ranges.length - 1, 0))
    show(false)
  })
  // The marks move when the preview's size changes (images load, <details>
  // toggle), its pane's does (the editor pane shows or hides, moving the
  // preview over without always resizing it), the window's does (the preview
  // stays centered), or a code block or table scrolls sideways
  const resizes = new ResizeObserver(() => draw())
  const pane = document.getElementById("preview-pane")

  function search() {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      // Mermaid's drawings carry their CSS in a <style>
      if (!walker.currentNode.parentElement?.closest("style")) {
        nodes.push(walker.currentNode as Text)
      }
    }
    ranges = findMatches(
      nodes.map((node) => node.data),
      input.value,
    ).map(({ start, end }) => {
      const range = document.createRange()
      range.setStart(nodes[start[0]], start[1])
      range.setEnd(nodes[end[0]], end[1])
      return range
    })
  }

  /** Mark the matches and count them, scrolling to the current one if
   * `scroll` */
  function show(scroll: boolean) {
    const range = ranges[current]
    count.textContent = range ? `${current + 1}/${ranges.length}` : input.value ? "0/0" : ""
    if (range && scroll) scrollTo(range)
    draw()
  }

  /** A box over each line of each match, in page coordinates, cut to the
   * visible part of a code block or table that scrolls sideways */
  function draw() {
    const boxes: HTMLElement[] = []
    ranges.forEach((range, i) => {
      const clip = range.startContainer.parentElement
        ?.closest("pre, table")
        ?.getBoundingClientRect()
      for (const rect of range.getClientRects()) {
        const left = Math.max(rect.left, clip?.left ?? -Infinity)
        const right = Math.min(rect.right, clip?.right ?? Infinity)
        if (right <= left || rect.height === 0) continue
        const box = document.createElement("div")
        if (i === current) box.className = "current"
        box.style.cssText = `left:${left + scrollX}px;top:${rect.top + scrollY}px;width:${right - left}px;height:${rect.height}px`
        boxes.push(box)
      }
    })
    marks.replaceChildren(...boxes)
  }

  function scrollTo(range: Range) {
    const node = range.startContainer
    // A match in a closed <details>, other than in its summary, has no box
    // until it opens
    for (
      let details = node.parentElement?.closest("details:not([open])");
      details;
      details = details.parentElement?.closest("details:not([open])")
    ) {
      if (!details.querySelector(":scope > summary")?.contains(node)) {
        ;(details as HTMLDetailsElement).open = true
      }
    }
    // Code blocks and tables scroll sideways on their own
    const scroller = node.parentElement?.closest("pre, table")
    let box = range.getBoundingClientRect()
    if (scroller) {
      const edges = scroller.getBoundingClientRect()
      if (box.left < edges.left || box.right > edges.right) {
        scroller.scrollLeft += box.left - edges.left - edges.width / 2
        box = range.getBoundingClientRect()
      }
    }
    if (box.top < 0 || box.bottom > innerHeight) {
      window.scrollBy(0, box.top - innerHeight / 2)
    }
  }

  function open() {
    if (bar.hidden) {
      returnFocus = document.activeElement
      bar.hidden = false
      observer.observe(content, { childList: true, subtree: true, characterData: true })
      resizes.observe(content)
      if (pane) resizes.observe(pane)
      window.addEventListener("resize", draw)
      content.addEventListener("scroll", draw, true)
      searchFromView()
    }
    input.focus()
    input.select()
  }

  function close() {
    bar.hidden = true
    observer.disconnect()
    resizes.disconnect()
    window.removeEventListener("resize", draw)
    content.removeEventListener("scroll", draw, true)
    ranges = []
    marks.replaceChildren()
    input.blur()
    if (returnFocus instanceof HTMLElement) returnFocus.focus()
  }

  /** Search, starting from the first match from the top of the view down,
   * as a browser's find does */
  function searchFromView() {
    search()
    current = Math.max(
      ranges.findIndex((range) => range.getBoundingClientRect().bottom > 0),
      0,
    )
    show(true)
  }

  function step(by: number) {
    if (ranges.length === 0) return
    current = (current + by + ranges.length) % ranges.length
    show(true)
  }

  input.addEventListener("input", searchFromView)
  input.addEventListener("keydown", (e) => {
    // Not while an IME is composing, where Enter picks the candidate
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  })
  // From anywhere on the page: helix's pane passes on the ⌘-chords it doesn't
  // bind (client.ts), and ⌘F would otherwise open the browser's own find
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === "f" && !e.shiftKey) {
      e.preventDefault()
      open()
    } else if (key === "g" && !bar.hidden) {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  })
}
