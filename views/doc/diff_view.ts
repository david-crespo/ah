/// <reference lib="dom" />

// The diff mode in the rendered preview (preview.ts): the blocks a diff
// (diff.ts) added marked, the ones it removed put back where they were, and
// the ones that moved (moves.ts) marked where they are now, numbered, with a
// placeholder where each was. Blocks are found by their data-line, the
// source lines render.ts stamps on them.

import type { MarkdownDiff } from "./diff.ts"
import type { Move } from "./moves.ts"

/** A block's source lines, [start, end), from its data-line */
export const lines = (el: HTMLElement) => el.dataset.line!.split(":").map(Number)

/** The innermost blocks whose lines overlap one of `ranges` */
export function innermostBlocks(content: HTMLElement, ranges: number[][]): HTMLElement[] {
  const hit = [...content.querySelectorAll<HTMLElement>("[data-line]")].filter((el) => {
    const [s, e] = lines(el)
    return ranges.some(([start, end]) => s < end && e > start)
  })
  return hit.filter((el) => !hit.some((other) => other !== el && el.contains(other)))
}

/** Mark the blocks the diff added, and put back the ones it removed, each
 * before the first block from where it was, rendered as `removed`. Mark the
 * blocks that moved, numbered, with a placeholder where each was. */
export function showDiff(
  content: HTMLElement,
  diff: MarkdownDiff,
  removed: string[],
  moves: Move[],
) {
  const blocks = [...content.querySelectorAll<HTMLElement>("[data-line]")]
  const added = new Set(innermostBlocks(content, diff.added).map(outer))
  // The removed go back first, so they go before an added <pre> or <table>,
  // not into its wrapper
  for (const [i, { line }] of diff.removed.entries()) {
    const panel = document.createElement("div")
    panel.className = "diff-removed"
    panel.innerHTML = removed[i]
    // Its lines aren't the file's: don't let flashes or ⌘-click find it
    for (const el of panel.querySelectorAll("[data-line]")) el.removeAttribute("data-line")
    const next = blocks.find((el) => lines(el)[0] >= line)
    if (next && putItems(panel, outer(next))) continue
    if (next?.matches("li")) {
      // Only items go between items: the rest goes after the list, after
      // what's already been put back there
      let at = next.parentElement!
      while (at.nextElementSibling?.classList.contains("diff-removed"))
        at = at.nextElementSibling as HTMLElement
      at.after(panel)
    } else if (next) outer(next).before(panel)
    else content.append(panel)
  }
  for (const el of added) mark(el, "diff-added")
  for (const [i, move] of moves.entries()) {
    const n = String(i + 1)
    const moved = markMoved(content, move.to)
    if (!moved) continue
    moved.dataset.move = n
    // Right after the innermost block it followed, else before the one it
    // came before
    const after = blocks
      .filter((el) => lines(el)[0] < move.was && move.was <= lines(el)[1])
      .at(-1)
    const before = blocks.find((el) => lines(el)[0] >= move.was)
    const at = after ?? before
    const from = document.createElement(at?.matches("li") ? "li" : "div")
    from.className = "diff-moved-from"
    from.dataset.move = n
    from.textContent = move.was <= move.to[0] ? "Moved down" : "Moved up"
    from.onclick = () => moved.scrollIntoView({ block: "center", behavior: "smooth" })
    if (after) outer(after).after(from)
    else if (before) outer(before).before(from)
    else content.append(from)
  }
  groupAdded(content)
  const left =
    content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft)
  for (const el of content.querySelectorAll<HTMLElement>(
    ".diff-added, .diff-removed, .diff-moved, .diff-moved-from",
  ))
    el.style.setProperty("--diff-indent", `${el.getBoundingClientRect().left - left}px`)
}

/** The element a block's lines are marked on: the <pre> of a fence's
 * <code>, the <table> of a row */
const outer = (el: HTMLElement) => el.closest<HTMLElement>("pre, table") ?? el

/** Give top-level blocks added one after another one bar, as the removed
 * ones before them have, by putting them in one div marked added. A list or
 * quote counts when all its blocks were added. */
function groupAdded(content: HTMLElement) {
  const isAdded = (el: Element) =>
    el.classList.contains("diff-added") ||
    (el.querySelector(".diff-added") !== null &&
      [...el.querySelectorAll<HTMLElement>("[data-line]")].every(
        (b) => b.closest(".diff-added") || b.querySelector("[data-line]"),
      ))
  let run: Element[] = []
  const flush = () => {
    if (run.length > 1 || (run.length === 1 && !run[0].classList.contains("diff-added"))) {
      const div = document.createElement("div")
      div.className = "diff-added"
      run[0].before(div)
      div.append(...run)
      for (const el of div.querySelectorAll(".diff-added"))
        el.classList.remove("diff-added")
    }
    run = []
  }
  // A copy, since the loop moves them into the div
  for (const el of Array.from(content.children)) {
    if (isAdded(el)) run.push(el)
    else flush()
  }
  flush()
}

/** Mark a block with `cls`. A fence's lines are on its <code> and a table's
 * on its rows, but the <pre> or <table> would clip the mark's bar, so it goes
 * on a wrapper. Returns what has the mark. */
function mark(el: HTMLElement, cls: string): HTMLElement {
  if (!el.matches("pre, table")) {
    el.classList.add(cls)
    return el
  }
  const div = document.createElement("div")
  div.className = cls
  el.replaceWith(div)
  div.append(el)
  return div
}

/** Mark the blocks on lines [start, end) as moved, each as far out as all
 * its blocks are, and those side by side outside a list in one div, for one
 * bar. Returns the first, if any. */
function markMoved(
  content: HTMLElement,
  [start, end]: [number, number],
): HTMLElement | undefined {
  // A move is of whole leaf blocks, so a block is in it when it starts in it:
  // a list's lines go on over the blank line after it
  const inside = (el: HTMLElement) =>
    [el, ...el.querySelectorAll<HTMLElement>("[data-line]")].every((b) => {
      if (!b.dataset.line) return true
      const [s] = lines(b)
      return s >= start && s < end
    })
  const tops = new Set<HTMLElement>()
  for (let el of innermostBlocks(content, [[start, end]]).map(outer)) {
    while (el.parentElement && el.parentElement !== content && inside(el.parentElement))
      el = el.parentElement
    tops.add(el)
  }
  const els = [...tops]
  if (els.length > 1 && !els[0].parentElement!.matches("ul, ol, dl")) {
    const div = document.createElement("div")
    div.className = "diff-moved"
    els[0].before(div)
    div.append(...els)
    return div
  }
  return els.map((el) => mark(el, "diff-moved"))[0]
}

/** When `panel` is just a list's items, or a description list's terms and
 * descriptions, put them back in the list marked removed, before the item
 * `next` is in, or at the end of the list just before it; returns whether it
 * could. In an ordered list, every item gets its number, so the removed ones
 * don't shift the others'. */
function putItems(panel: HTMLElement, next: HTMLElement): boolean {
  const list = panel.querySelector("ul, ol, dl")
  const only = (el: Element | null): boolean =>
    el === list || (el?.children.length === 1 && only(el.firstElementChild))
  if (!list || !only(panel)) return false
  const before = next.closest("li, dt, dd")
  const prev = next.previousElementSibling
  const into =
    before?.parentElement ??
    (prev?.matches("ul, ol, dl")
      ? prev
      : prev?.querySelector(":scope > ul, :scope > ol, :scope > dl"))
  if (!into || into.tagName !== list.tagName) return false
  const items = [...list.children].filter((el) => ["LI", "DT", "DD"].includes(el.tagName))
  if (into instanceof HTMLOListElement) {
    const own = [...into.children].filter((el) => el.tagName === "LI") as HTMLLIElement[]
    own.forEach((li, j) => (li.value ||= into.start + j))
    let n = before ? (before as HTMLLIElement).value : into.start + own.length
    for (const li of items as HTMLLIElement[]) li.value = n++
  }
  for (const item of items) {
    item.classList.add("diff-removed")
    if (before) before.before(item)
    else into.append(item)
  }
  return true
}
