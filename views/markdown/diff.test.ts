import { describe, expect, test } from "vitest"
import { CLOSE, diffMarkdown, leafBlocks, OPEN } from "./diff.ts"
import { createMarkdown } from "./render.ts"

const md = createMarkdown()
const blocksOf = (t: string) => leafBlocks(md.parse(t, { nested: true }))
const diff = (prev: string, next: string) =>
  diffMarkdown(prev, next, [blocksOf(prev), blocksOf(next)])

/** The marked text with each inline change as [-old-]{+new+} */
function inline(prev: string, next: string): string {
  const d = diff(prev, next)
  expect(d.text.split("\n").length).toBe(next.split("\n").length)
  return d.text
    .replace(new RegExp(`${OPEN}(\\d+)\\}`, "g"), (_, i) => `[-${d.old[Number(i)]}-]{+`)
    .replaceAll(CLOSE, "+}")
}

describe("diffMarkdown", () => {
  test("leaves an unchanged file alone", () => {
    const text = "# Title\n\nSome text.\n"
    expect(diff(text, text)).toEqual({ text, old: [], removed: [], added: [], changes: 0 })
  })

  test("leaves blank lines added or removed between blocks alone", () => {
    for (const [prev, next] of [
      ["One.\n\n\nTwo.\n", "One.\n\nTwo.\n"],
      ["- a\n\n- b\n- c\n", "- a\n- b\n- c\n"],
      ["# A\nOne.\n", "# A\n\n\nOne.\n"],
    ])
      expect(diff(prev, next)).toEqual({
        text: next,
        old: [],
        removed: [],
        added: [],
        changes: 0,
      })
  })

  test("shows a paragraph split in two, and a blank line added in code", () => {
    expect(diff("One. Two.\n", "One.\n\nTwo.\n").changes).toBeGreaterThan(0)
    expect(diff("One\nTwo\n", "One\n\nTwo\n").changes).toBeGreaterThan(0)
    expect(diff("```\na\nb\n```\n", "```\na\n\nb\n```\n").changes).toBe(1)
  })

  test("marks a changed word inline", () => {
    expect(inline("The pane saves after 650ms.\n", "The pane saves after 800ms.\n")).toBe(
      "The pane saves after [-650ms-]{+800ms+}.\n",
    )
  })

  test("marks a sentence added at a line's end as only an addition", () => {
    expect(inline("Intro. It ends.\n", "Intro. It ends. Now with diffs!\n")).toBe(
      "Intro. It ends. [--]{+Now with diffs!+}\n",
    )
    expect(inline("Intro. It ends.\n", "Intro. It ends. Live editing... now!\n")).toBe(
      "Intro. It ends. [--]{+Live editing... now!+}\n",
    )
  })

  test("marks a sentence that repeats words around it as only an addition", () => {
    expect(inline("Start. It ends.\n", "Start. It ends. Then it ends again.\n")).toBe(
      "Start. It ends. [--]{+Then it ends again.+}\n",
    )
  })

  test("marks words added inside a sentence as only an addition", () => {
    expect(inline("Open the pane. Done.\n", "Open the big new pane. Done.\n")).toBe(
      "Open the [--]{+big new+} pane. Done.\n",
    )
  })

  test("marks a sentence removed at a line's end as only a removal", () => {
    expect(inline("Intro. It ends. Gone now.\n", "Intro. It ends.\n")).toBe(
      "Intro. It ends.[- Gone now.-]{++}\n",
    )
  })

  test("marks a removed sentence that repeats words around it as only a removal", () => {
    expect(inline("Start. It ends. Then it ends again.\n", "Start. It ends.\n")).toBe(
      "Start. It ends.[- Then it ends again.-]{++}\n",
    )
  })

  test("shows a mostly rewritten paragraph as old, then new", () => {
    const d = diff(
      "Intro.\n\nFirst of all, it is not tied to Helix. You can swap it. It worked great.\n",
      "Intro.\n\nIt is not tied to Helix in any deep way. To use another editor, see below.\n",
    )
    expect(d.old).toEqual([])
    expect(d.removed).toEqual([
      {
        line: 2,
        text: "First of all, it is not tied to Helix. You can swap it. It worked great.\n",
      },
    ])
    expect(d.added).toEqual([[2, 3]])
  })

  test("marks a reworded stretch without the sentence's kept ends", () => {
    expect(
      inline(
        "One stays. Two stays. The pane saves after a while. Four stays.\n",
        "One stays. Two stays. The pane saves once you stop typing. Four stays.\n",
      ),
    ).toBe(
      "One stays. Two stays. The pane saves [-after a while-]{+once you stop typing+}. Four stays.\n",
    )
  })

  test("keeps a rewording of less than half its sentence inline", () => {
    expect(
      inline(
        "Another thing it can't know: preferences you have or we as a team have that people could disagree on.\n",
        "Another thing it can't know: preferences, yours or the team's, that people could disagree on.\n",
      ),
    ).toBe(
      "Another thing it can't know: preferences[- you have or we as a team have-]{+, yours or the team's,+} that people could disagree on.\n",
    )
  })

  test("joins changes close together in a sentence into one", () => {
    expect(
      inline(
        "It starts. Red panes save after short waits. It ends.\n",
        "It starts. Blue panes quit after long pauses. It ends.\n",
      ),
    ).toBe(
      "It starts. [-Red panes save after short waits-]{+Blue panes quit after long pauses+}. It ends.\n",
    )
  })

  test("keeps changes far apart in a sentence apart", () => {
    expect(
      inline(
        "If you have a skill called `/matrix`, and you tell Claude to search Matrix, it knows what to do.\n",
        "If you have a skill called `matrix`, and you tell Claude to search Matrix, it picks it up.\n",
      ),
    ).toBe(
      "If you have a skill called [-`/matrix`-]{+`matrix`+}, and you tell Claude to search Matrix, it [-knows what to do-]{+picks it up+}.\n",
    )
  })

  test("keeps a change in a hard-wrapped paragraph inline", () => {
    expect(inline("one two\nthree four\n", "one two\nthree five\n")).toBe(
      "one two\nthree [-four-]{+five+}\n",
    )
  })

  test("widens a change inside a code span to the span", () => {
    expect(inline("Run `ah view` now.\n", "Run `ah open` now.\n")).toBe(
      "Run [-`ah view`-]{+`ah open`+} now.\n",
    )
    expect(inline("Run `npm test` now.\n", "Run `npm run test` now.\n")).toBe(
      "Run [-`npm test`-]{+`npm run test`+} now.\n",
    )
  })

  test("keeps a change beside a code span inline", () => {
    expect(
      inline(
        "Only `name` and `description` load up front, in order.\n",
        "Only `name` and `description` load up first, in order.\n",
      ),
    ).toBe("Only `name` and `description` load up [-front-]{+first+}, in order.\n")
    expect(
      inline("Like a `CLAUDE.md` is.\n", "Like a `CLAUDE.md` or `AGENTS.md` is.\n"),
    ).toBe("Like a `CLAUDE.md` [--]{+or `AGENTS.md`+} is.\n")
  })

  test("widens a change in a link's target to the link, and in a URL to the URL", () => {
    expect(
      inline(
        "See [the docs](https://a.com/x) here.\n",
        "See [the docs](https://a.com/y) here.\n",
      ),
    ).toBe("See [-[the docs](https://a.com/x)-]{+[the docs](https://a.com/y)+} here.\n")
    expect(inline("See https://a.com/x.\n", "See https://a.com/y.\n")).toBe(
      "See [-https://a.com/x-]{+https://a.com/y+}.\n",
    )
  })

  test("returns a new paragraph as added lines", () => {
    const d = diff("One.\n\nThree.\n", "One.\n\nTwo.\n\nThree.\n")
    expect(d.text).toBe("One.\n\nTwo.\n\nThree.\n")
    expect(d.added).toEqual([[2, 4]])
    expect(d.removed).toEqual([])
  })

  test("shows blocks changed one after another as the old ones, then the new", () => {
    const one = "The first paragraph says one thing about how the skills are set up here.\n"
    const two = "The second paragraph says another thing about where the skills live now.\n"
    const three = "A new paragraph takes the place of the first, with nothing in common.\n"
    const four =
      "Another new one replaces the second, and again shares no words with it at all.\n"
    const d = diff(`Kept.\n\n${one}\n${two}\nEnd.\n`, `Kept.\n\n${three}\n${four}\nEnd.\n`)
    expect(d.removed).toEqual([{ line: 2, text: `${one}\n${two}` }])
    expect(d.added).toEqual([[2, 5]])
  })

  test("returns a removed paragraph with where it was", () => {
    const d = diff("One.\n\nTwo.\n\nThree.\n", "One.\n\nThree.\n")
    expect(d.removed).toEqual([{ line: 2, text: "Two.\n\n" }])
    expect(d.added).toEqual([])
  })

  test("takes a new list item as a block", () => {
    const d = diff("- a\n- c\n", "- a\n- b\n- c\n")
    expect(d.text).toBe("- a\n- b\n- c\n")
    expect(d.added).toEqual([[1, 2]])
  })

  test("takes a heading's level change as a block", () => {
    const d = diff("## Setup\n", "### Setup\n")
    expect(d.removed).toEqual([{ line: 0, text: "## Setup\n" }])
    expect(d.added).toEqual([[0, 1]])
  })

  test("takes a change in a code fence as the whole fence", () => {
    const d = diff("Text.\n\n```sh\nls\npwd\n```\n", "Text.\n\n```sh\nls -l\npwd\n```\n")
    expect(d.removed).toEqual([{ line: 2, text: "```sh\nls\npwd\n```\n" }])
    expect(d.added).toEqual([[2, 6]])
  })

  test("marks a sentence added at a paragraph's start as only an addition", () => {
    expect(
      inline(
        "The server restarts itself. Pages reconnect.\n",
        "Saving is enough. The server restarts itself. Pages reconnect.\n",
      ),
    ).toBe("[--]{+Saving is enough.+} The server restarts itself. Pages reconnect.\n")
  })

  test("keeps an added sentence with a code span in it inline", () => {
    expect(
      inline(
        "Comments go to its agent. If it's gone, they queue.\n",
        "Comments go to its agent. Rebind it with `ah view open`. If it's gone, they queue.\n",
      ),
    ).toBe(
      "Comments go to its agent. [--]{+Rebind it with `ah view open`.+} If it's gone, they queue.\n",
    )
  })

  test("marks a word changed inside bold within the bold", () => {
    expect(
      inline(
        "This is **very important** for all.\n",
        "This is **really important** for all.\n",
      ),
    ).toBe("This is **[-very-]{+really+} important** for all.\n")
  })

  test("marks words added before an ellipsis without taking its dots", () => {
    expect(
      inline(
        "It waits... then saves — unless you type.\n",
        "It waits a moment... then saves — unless you type.\n",
      ),
    ).toBe("It waits [--]{+a moment+}... then saves — unless you type.\n")
  })

  test("marks a renamed heading inline, after its marker", () => {
    expect(inline("### Install the CLI\n", "### Install the command line tool\n")).toBe(
      "### Install the [-CLI-]{+command line tool+}\n",
    )
  })

  test("marks a word added in a quoted, wrapped paragraph inline", () => {
    expect(
      inline(
        "> The pane saves after a pause. Nothing is lost\n> when you close it.\n",
        "> The pane saves after a short pause. Nothing is lost\n> when you close it.\n",
      ),
    ).toBe(
      "> The pane saves after a [--]{+short+} pause. Nothing is lost\n> when you close it.\n",
    )
  })

  test("keeps a new wrapped line at a paragraph's end inline", () => {
    expect(
      inline(
        "It ends here.\n\nNext.\n",
        "It ends here. A new sentence\nwraps onto the next line.\n\nNext.\n",
      ),
    ).toBe("It ends here. [--]{+A new sentence\nwraps onto the next line.+}\n\nNext.\n")
  })

  test("returns a removed list item with where it was", () => {
    const d = diff("- Alpha\n- Beta goes away\n- Gamma\n", "- Alpha\n- Gamma\n")
    expect(d.removed).toEqual([{ line: 1, text: "- Beta goes away\n" }])
    expect(d.added).toEqual([])
  })

  test("takes a new nested list item as a block of its own", () => {
    const d = diff(
      "- Setup\n  - Install Node\n  - Install jj\n",
      "- Setup\n  - Install Node\n  - Install Bun\n  - Install jj\n",
    )
    expect(d.added).toEqual([[2, 3]])
    expect(d.removed).toEqual([])
  })

  test("marks a change inside emphasis inline", () => {
    expect(
      inline(
        "The server **never** writes. Use *ah view open* to show it.\n",
        "The server **rarely** writes. Use *ah view show* to show it.\n",
      ),
    ).toBe(
      "The server **[-never-]{+rarely+}** writes. Use *ah view [-open-]{+show+}* to show it.\n",
    )
  })

  test("leaves a rewrapped paragraph unmarked", () => {
    const next = "One two three\nfour five six\nseven.\n"
    expect(inline("One two three four\nfive six seven.\n", next)).toBe(next)
  })

  test("marks a line added to a quoted paragraph inline", () => {
    expect(
      inline(
        "> Quote line one.\n> Quote line two.\n",
        "> Quote line one.\n> A new line.\n> Quote line two.\n",
      ),
    ).toBe("> Quote line one.\n> [--]{+A new line.+}\n> Quote line two.\n")
  })

  // Adding an item renumbers the ones after it, which isn't a change to them
  test("takes only the new item of a renumbered ordered list", () => {
    const d = diff(
      "1. Clone the repo\n2. Run the build\n3. Start the server\n",
      "1. Clone the repo\n2. Install the dependencies\n3. Run the build\n4. Start the server\n",
    )
    expect(d.removed).toEqual([])
    expect(d.added).toEqual([[1, 2]])
  })

  test("marks a word changed while rewrapping, and only it", () => {
    expect(
      inline(
        "One two three four\nfive six seven.\n",
        "One two three\nfour 5 six\nseven.\n",
      ),
    ).toBe("One two three\nfour [-five-]{+5+} six\nseven.\n")
  })

  test("still marks a removed hard break", () => {
    expect(diff("One two  \nthree.\n", "One two\nthree.\n").changes).toBe(1)
  })

  test("still marks a heading's number", () => {
    const d = diff("## 2. Setup\n", "## 3. Setup\n")
    expect(d.removed).toEqual([{ line: 0, text: "## 2. Setup\n" }])
    expect(d.added).toEqual([[0, 1]])
  })

  test("marks a line removed from a quoted paragraph inline", () => {
    const d = diff("> One.\n> Gone.\n> Two.\n", "> One.\n> Two.\n")
    expect(d.removed).toEqual([])
    expect(d.old.map((o) => o.trim())).toEqual(["Gone."])
  })

  test("takes a file that wasn't there as all new", () => {
    const d = diff("", "# New\n\nText.\n")
    expect(d.added).toEqual([[0, 3]])
    expect(d.text).toBe("# New\n\nText.\n")
  })
})
