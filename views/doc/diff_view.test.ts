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
    // A table takes its rows' marks, but a new alignment takes all of it
    const table = preview("| a |\n|---|\n| 1 |\n", "| a |\n|:-:|\n| 1 |\n")
    expect(table.querySelector("table[data-line]")!.parentElement!.className).toBe(
      "diff-added",
    )
  })
})

describe("tables", () => {
  const table = (...rows: string[]) => `| Key | Value |\n|---|---|\n${rows.join("")}`

  test("a change in a cell is marked inline, in one table", () => {
    const settings = (refresh: string) =>
      "| Key | Default | Meaning |\n|---|---|---|\n" +
      "| `style.cursor` | `blue` | Cursor line color |\n" +
      `| \`general.refresh\` | \`${refresh}\` | When to reload status |\n` +
      "| `diff.renderer` | `builtin` | Which renderer draws diffs |\n"
    const content = preview(settings("on-focus"), settings("on-change"))
    expect(content.querySelectorAll("table").length).toBe(1)
    expect(content.querySelector(".diff-added, .diff-removed")).toBeNull()
    const cell = content.querySelector("del.diff-old")!.closest("td")!
    expect(cell.innerHTML).toBe(
      '<del class="diff-old"><code>on-focus</code></del><ins class="diff-new"><code>on-change</code></ins>',
    )
  })

  test("an added row is marked in the table", () => {
    const content = preview(table("| a | 1 |\n"), table("| a | 1 |\n| b | 2 |\n"))
    expect(outline(content)).toEqual(["Key Value", "a 1", "+ b 2"])
    expect(content.querySelector("tr.diff-added")).not.toBeNull()
    expect(content.querySelector("table")!.parentElement).toBe(content)
  })

  test("a removed row goes back in the table where it was, without its lines", () => {
    const content = preview(
      table("| a | 1 |\n| b | 2 |\n| c | 3 |\n"),
      table("| a | 1 |\n| c | 3 |\n"),
    )
    expect(outline(content)).toEqual(["Key Value", "a 1", "- b 2", "c 3"])
    expect(content.querySelectorAll("table").length).toBe(1)
    expect(content.querySelector("tr.diff-removed")!.parentElement!.tagName).toBe("TBODY")
    expect(
      content.querySelector(".diff-removed [data-line], tr.diff-removed[data-line]"),
    ).toBeNull()
    expect(outline(preview(table("| a | 1 |\n| b | 2 |\n"), table("| a | 1 |\n")))).toEqual(
      ["Key Value", "a 1", "- b 2"],
    )
    expect(outline(preview(table("| a | 1 |\n"), table()))).toEqual(["Key Value", "- a 1"])
  })

  test("a row changed across cells is the old row, then the new", () => {
    expect(
      outline(preview(table("| a | 1 |\n| b | 2 |\n"), table("| a | 1 |\n| b 2 |\n"))),
    ).toEqual(["Key Value", "a 1", "- b 2", "+ b 2"])
  })

  test("rows that swapped are removed and added in the table, not moved", () => {
    const one = "| the first row has a good many words in it | 1 |\n"
    const two = "| the second row has a good many words in it too | 2 |\n"
    const content = preview(table(one, two, "| c | 3 |\n"), table(two, one, "| c | 3 |\n"))
    expect(content.querySelector(".diff-moved, .diff-moved-from")).toBeNull()
    expect(content.querySelectorAll("table").length).toBe(1)
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

describe("table columns", () => {
  /** A table of `|`-separated cells, a row to a string, with a delimiter row
   * after the first */
  const grid = (...rows: string[]) =>
    rows
      .map((r) => `| ${r.split("|").join(" | ")} |\n`)
      .toSpliced(
        1,
        0,
        `|${rows[0]
          .split("|")
          .map(() => "---")
          .join("|")}|\n`,
      )
      .join("")
  /** Each row's cells, after + or - when the cell or its row is marked */
  const cells = (content: HTMLElement) =>
    [...content.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((cell) => {
        const mark = cell.closest(".diff-added, .diff-removed")
        const sign = !mark ? "" : mark.classList.contains("diff-added") ? "+" : "-"
        return `${sign}${cell.textContent}`
      }),
    )

  test("a new column's cells are marked, in one table", () => {
    const content = preview(grid("Key|Value", "a|1"), grid("Key|Note|Value", "a|x|1"))
    expect(content.querySelectorAll("table").length).toBe(1)
    expect(content.querySelector("table")!.parentElement).toBe(content)
    expect(cells(content)).toEqual([
      ["Key", "+Note", "Value"],
      ["a", "+x", "1"],
    ])
  })

  test("a removed column's cells go back where they were, from the old table", () => {
    const content = preview(grid("Key|Note|Value", "a|*x*|1"), grid("Key|Value", "a|1"))
    expect(content.querySelectorAll("table").length).toBe(1)
    expect(cells(content)).toEqual([
      ["Key", "-Note", "Value"],
      ["a", "-x", "1"],
    ])
    expect(content.querySelector("td.diff-removed em")).not.toBeNull()
    expect(content.querySelector("th.diff-removed")).not.toBeNull()
  })

  test("a row removed alongside a new column goes back with an empty cell under it", () => {
    const content = preview(
      grid("Key|Value", "a|1", "b|2"),
      grid("Key|Value|Note", "a|1|x"),
    )
    expect(cells(content)).toEqual([
      ["Key", "Value", "+Note"],
      ["a", "1", "+x"],
      ["-b", "-2", "-"],
    ])
  })

  test("a row added alongside a removed column has an empty cell where the column was", () => {
    const content = preview(
      grid("Key|Note|Value", "a|x|1"),
      grid("Key|Value", "a|1", "b|2"),
    )
    expect(cells(content)).toEqual([
      ["Key", "-Note", "Value"],
      ["a", "-x", "1"],
      ["+b", "-", "+2"],
    ])
  })

  test("a row removed alongside a removed column goes back with all its cells", () => {
    const content = preview(
      grid("Key|Note|Value", "a|x|1", "b|y|2"),
      grid("Key|Value", "a|1"),
    )
    expect(cells(content)).toEqual([
      ["Key", "-Note", "Value"],
      ["a", "-x", "1"],
      ["-b", "-y", "-2"],
    ])
  })

  test("a cell edited beside a new column is marked inline", () => {
    const content = preview(grid("Key|Value", "a|1"), grid("Key|Note|Value", "a|x|2"))
    expect(cells(content)).toEqual([
      ["Key", "+Note", "Value"],
      ["a", "+x", "12"],
    ])
    expect(content.querySelector("del.diff-old")!.closest("td")!.cellIndex).toBe(2)
  })
})
