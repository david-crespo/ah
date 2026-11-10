// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"
import { diffMarkdown, leafBlocks } from "./diff.ts"
import { showDiff } from "./diff_view.ts"
import { findMoves, moveBase } from "./moves.ts"
import { CASES } from "./moves_cases.ts"
import { createMarkdown } from "./render.ts"

const md = createMarkdown()
const blocksOf = (t: string) => leafBlocks(md.parse(t, { nested: true }))

/** `next` in the preview's diff mode from `prev`, as preview.ts renders it */
function preview(prev: string, next: string): HTMLElement {
  const moves = findMoves(prev, next, [blocksOf(prev), blocksOf(next)])
  const moved = moveBase(prev, next, moves)
  const diff = diffMarkdown(moved, next, [blocksOf(moved), blocksOf(next)])
  const content = document.createElement("article")
  content.innerHTML = md.render(diff.text, { diff })
  const removed = diff.removed.map((r) => md.render(r.text, { nested: true }))
  showDiff(content, diff, removed, moves)
  return content
}

const SIGNS: Record<string, string> = {
  "diff-added": "+",
  "diff-removed": "-",
  "diff-moved": "~",
  "diff-moved-from": "^",
}

/** The preview's blocks in order, each as its own text, after + when it's
 * marked added, - removed, ~n moved (move n), or ^n where move n was */
function outline(content: HTMLElement): string[] {
  const blocks = content.querySelectorAll<HTMLElement>(
    "h1, h2, h3, h4, h5, h6, p, pre, tr, li, .diff-moved-from",
  )
  return [...blocks].flatMap((el) => {
    const own = [...el.childNodes].filter(
      (n) => !(n instanceof HTMLElement && n.matches("ul, ol, p")),
    )
    const text = own
      .map((n) => n.textContent)
      .join("")
      .trim()
      .replace(/\s+/g, " ")
    if (!text) return []
    const mark = el.closest<HTMLElement>(
      Object.keys(SIGNS)
        .map((c) => `.${c}`)
        .join(", "),
    )
    if (!mark) return [text]
    const sign = SIGNS[[...mark.classList].find((c) => c in SIGNS)!]
    return [`${sign}${mark.dataset.move ?? ""} ${text}`]
  })
}

describe("added and removed blocks", () => {
  test("an added block is marked, in its list when it's an item", () => {
    expect(outline(preview("One.\n\nThree.\n", "One.\n\nTwo.\n\nThree.\n"))).toEqual([
      "One.",
      "+ Two.",
      "Three.",
    ])
    expect(outline(preview("- a\n- c\n", "- a\n- b\n- c\n"))).toEqual(["a", "+ b", "c"])
    expect(
      outline(
        preview(
          "- Setup\n  - Install Node\n  - Install jj\n",
          "- Setup\n  - Install Node\n  - Install Bun\n  - Install jj\n",
        ),
      ),
    ).toEqual(["Setup", "Install Node", "+ Install Bun", "Install jj"])
  })

  test("a removed block goes back where it was, without its lines", () => {
    const content = preview("One.\n\nTwo.\n\nThree.\n", "One.\n\nThree.\n")
    expect(outline(content)).toEqual(["One.", "- Two.", "Three."])
    // Not for flashes or ⌘-click to find
    expect(content.querySelector(".diff-removed [data-line]")).toBeNull()
  })

  test("a block changed in place is the old one, then the new", () => {
    expect(outline(preview("## Setup\n", "### Setup\n"))).toEqual(["- Setup", "+ Setup"])
  })

  test("removed items go back in their list, numbered as they were", () => {
    expect(
      outline(preview("- Alpha\n- Beta goes away\n- Gamma\n", "- Alpha\n- Gamma\n")),
    ).toEqual(["Alpha", "- Beta goes away", "Gamma"])
    const content = preview(
      "1. One\n2. Two\n3. Three\n4. Four\n",
      "1. One\n2. Three\n3. Four\n",
    )
    expect(outline(content)).toEqual(["One", "- Two", "Three", "Four"])
    expect(content.querySelectorAll("ol").length).toBe(1)
    expect([...content.querySelectorAll("li")].map((li) => li.value)).toEqual([1, 2, 2, 3])
  })

  test("a removed block that isn't an item goes after the list, not between items", () => {
    const content = preview("- a\n- b\n\nGone.\n\n- c\n", "- a\n- b\n- c\n")
    expect(outline(content)).toEqual(["a", "b", "c", "- Gone."])
    expect(content.querySelector("ul")!.nextElementSibling!.className).toBe("diff-removed")
    expect(outline(preview("Para.\n\n- a\n- b\n", "- a\n- b\n"))).toEqual([
      "- Para.",
      "a",
      "b",
    ])
  })

  test("blocks added one after another have one mark, after the removed ones", () => {
    const one = "The first paragraph says one thing about how the skills are set up here.\n"
    const two = "The second paragraph says another thing about where the skills live now.\n"
    const three = "A new paragraph takes the place of the first, with nothing in common.\n"
    const four =
      "Another new one replaces the second, and again shares no words with it at all.\n"
    const content = preview(
      `Kept.\n\n${one}\n${two}\nEnd.\n`,
      `Kept.\n\n${three}\n${four}\nEnd.\n`,
    )
    expect([...content.children].map((el) => [el.tagName, el.className])).toEqual([
      ["P", ""],
      ["DIV", "diff-removed"],
      ["DIV", "diff-added"],
      ["P", ""],
    ])
    expect(content.children[1].children.length).toBe(2)
    expect(content.children[2].children.length).toBe(2)
    expect(content.querySelectorAll(".diff-added").length).toBe(1)
    expect(outline(preview("", "# New\n\nText.\n"))).toEqual(["+ New", "+ Text."])
  })

  test("a fence or a table is marked on a wrapper, which wouldn't clip the mark", () => {
    const content = preview(
      "Text.\n\n```sh\nls\npwd\n```\n",
      "Text.\n\n```sh\nls -l\npwd\n```\n",
    )
    expect(
      content.querySelector("pre code[data-line]")!.closest("pre")!.parentElement!
        .className,
    ).toBe("diff-added")
    const table = preview("| a |\n|---|\n| 1 |\n", "| a |\n|---|\n| 1 |\n| 2 |\n")
    expect(table.querySelector("table[data-line]")!.parentElement!.className).toBe(
      "diff-added",
    )
  })
})

describe("moves", () => {
  test("a block that moved is marked where it is, with a placeholder where it was", () => {
    expect(outline(preview("One.\n\nTwo.\n\nSix.\n", "One.\n\nSix.\n\nTwo.\n"))).toEqual([
      "One.",
      "^1 Moved down",
      "Six.",
      "~1 Two.",
    ])
    expect(outline(preview("A.\n\nB.\n\nC.\n", "C.\n\nA.\n\nB.\n"))).toEqual([
      "~1 C.",
      "A.",
      "B.",
      "^1 Moved up",
    ])
  })

  test("an item's placeholder is an item of the list it left", () => {
    const content = preview("- a\n- b\n\nText.\n\n- c\n", "- a\n\nText.\n\n- c\n- b\n")
    expect(outline(content)).toEqual(["a", "^1 Moved down", "Text.", "c", "~1 b"])
    expect(content.querySelector(".diff-moved-from")!.parentElement!.tagName).toBe("UL")
  })

  test("blocks that moved together have one mark, and moves are numbered", () => {
    const content = preview(
      "# T\n\n## A\n\nOne.\n\n## B\n\nTwo.\n\n## C\n\nThree.\n",
      "# T\n\n## C\n\nThree.\n\n## A\n\nOne.\n\n## B\n\nTwo.\n",
    )
    expect(outline(content)).toEqual([
      "T",
      "~1 C",
      "~1 Three.",
      "A",
      "One.",
      "B",
      "Two.",
      "^1 Moved up",
    ])
    expect(content.querySelectorAll(".diff-moved").length).toBe(1)
  })

  test.each(CASES)("$name", ({ prev, next, moves }) => {
    const content = preview(prev, next)
    const moved = [...content.querySelectorAll<HTMLElement>(".diff-moved")]
    const from = [...content.querySelectorAll<HTMLElement>(".diff-moved-from")]
    const numbers = moves.map((_, i) => String(i + 1))
    expect(moved.map((el) => el.dataset.move)).toEqual(numbers)
    expect(from.map((el) => el.dataset.move).sort()).toEqual(numbers)
    // Blocks that only moved aren't also added or removed
    if (moves.length && moves.every((m) => m.from === m.to))
      expect(content.querySelector(".diff-added, .diff-removed")).toBeNull()
    // A list moves whole, or its items move within lists
    for (const li of content.querySelectorAll("li"))
      expect(li.parentElement!.tagName).toMatch(/^[UO]L$/)
    expect(content.querySelector("ul:empty, ol:empty")).toBeNull()
  })
})
