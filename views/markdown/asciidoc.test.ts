import { expect, test } from "vitest"
import { asciidocBlocks, renderAsciidoc } from "./asciidoc.ts"
import { ASCIIDOC, CLOSE, diffMarkdown, OPEN } from "./diff.ts"

const source = `= Title
:numbered:

Preamble.

== One

First paragraph
on two lines.

* a
* b

== Two

[source,rust]
----
fn main() {}
----
`

/** Each data-line in the output, with the element it's on */
const stamps = (html: string) =>
  [...html.matchAll(/<([a-z0-9]+)[^>]*data-line="(\d+:\d+)"/g)].map(
    ([, tag, lines]) => `${tag} ${lines}`,
  )

test("blocks carry their 0-based source lines, up to the next block outside them", async () => {
  expect(stamps(await renderAsciidoc(source))).toEqual([
    "h1 0:1", // the document's title
    "div 3:5", // the preamble
    "div 3:5", // its paragraph
    "div 5:13", // section One, up to section Two
    "div 7:10",
    "div 10:13", // the list
    "li 10:11", // its items
    "li 11:13",
    "div 13:20", // section Two, to the end of the file
    "div 16:20", // the listing, from its delimiter rather than its attribute line
  ])
})

test("the title shows, and the file's attributes apply", async () => {
  const html = await renderAsciidoc(source)
  expect(html).toContain(">Title</h1>")
  expect(html).toContain("1. One")
})

test("a file can still hide its title", async () => {
  expect(await renderAsciidoc(`= Title\n:showtitle!:\n\nText.`)).not.toContain("<h1>")
})

test("the leaf blocks are a section's title, a list item's text and blocks with no blocks in them", async () => {
  expect(await asciidocBlocks(source)).toEqual([
    { start: 0, end: 1, opaque: false }, // the document's title
    { start: 3, end: 4, opaque: false }, // the preamble's paragraph
    { start: 5, end: 6, opaque: false }, // section One's title
    { start: 7, end: 9, opaque: false },
    { start: 10, end: 11, opaque: false },
    { start: 11, end: 12, opaque: false },
    { start: 13, end: 14, opaque: false }, // section Two's title
    // The listing with its attribute line and delimiters
    { start: 15, end: 19, opaque: true },
  ])
})

test("a list item's text ends at a list nested in it, and a term shares its line", async () => {
  expect(await asciidocBlocks("* a\n** b\n* c\n\nterm:: desc\n")).toEqual([
    { start: 0, end: 1, opaque: false },
    { start: 1, end: 2, opaque: false },
    { start: 2, end: 3, opaque: false },
    { start: 4, end: 5, opaque: false },
  ])
})

test("a block in a delimited block leaves out its closing delimiter", async () => {
  expect(await asciidocBlocks("====\nInside.\n====\n\nAfter.\n")).toEqual([
    { start: 1, end: 2, opaque: false },
    { start: 4, end: 5, opaque: false },
  ])
})

/** The diff of two AsciiDoc texts, with each inline change as [-old-]{+new+} */
async function diff(prev: string, next: string) {
  const d = diffMarkdown(
    prev,
    next,
    await Promise.all([asciidocBlocks(prev), asciidocBlocks(next)]),
    ASCIIDOC,
  )
  const text = d.text
    .replace(new RegExp(`${OPEN}(\\d+)\\}`, "g"), (_, i) => `[-${d.old[Number(i)]}-]{+`)
    .replaceAll(CLOSE, "+}")
  return { ...d, text }
}

test("marks a changed word inline", async () => {
  expect(
    (await diff("== One\n\nThe pane saves.\n", "== One\n\nThe pane quits.\n")).text,
  ).toBe("== One\n\nThe pane [-saves-]{+quits+}.\n")
})

test("takes a new list item as a block", async () => {
  const d = await diff("* a\n* c\n", "* a\n* b\n* c\n")
  expect(d.added).toEqual([[1, 2]])
})

test("takes a change in a listing as the whole listing", async () => {
  const d = await diff(
    "Text.\n\n----\nls\npwd\n----\n",
    "Text.\n\n----\nls -l\npwd\n----\n",
  )
  expect(d.removed).toEqual([{ line: 2, text: "----\nls\npwd\n----\n" }])
  expect(d.added).toEqual([[2, 6]])
})

test("widens a change touching inline markup to its sentence", async () => {
  expect((await diff("It is *bold* now. Done.\n", "It is _bold_ now. Done.\n")).text).toBe(
    "[-It is *bold* now.-]{+It is _bold_ now.+} Done.\n",
  )
})

test("renders the inline marks as the old words, then the new", async () => {
  const d = diffMarkdown(
    "The *pane* saves.\n",
    "The *pane* quits.\n",
    await Promise.all([
      asciidocBlocks("The *pane* saves.\n"),
      asciidocBlocks("The *pane* quits.\n"),
    ]),
    ASCIIDOC,
  )
  expect(await renderAsciidoc(d.text, d.old)).toContain(
    '<strong>pane</strong> <del class="diff-old">saves</del><ins class="diff-new">quits</ins>.',
  )
})

test("marks a word added in an admonition paragraph inline", async () => {
  expect(
    (
      await diff(
        "NOTE: The pane saves after a pause. Nothing is lost.\n",
        "NOTE: The pane saves after a short pause. Nothing is lost.\n",
      )
    ).text,
  ).toBe("NOTE: The pane saves after a [--]{+short+} pause. Nothing is lost.\n")
})

test("marks a reworded sentence in a sidebar inline", async () => {
  expect(
    (
      await diff(
        "****\nIt runs on port 7420 by default. Pass --port to change it.\n****\n",
        "****\nIt runs on port 7420 unless told otherwise. Pass --port to change it.\n****\n",
      )
    ).text,
  ).toBe(
    "****\n[-It runs on port 7420 by default.-]{+It runs on port 7420 unless told otherwise.+} Pass --port to change it.\n****\n",
  )
})

test("takes only the new item of an ordered list", async () => {
  const d = await diff(
    ". Clone\n. Build\n. Start\n",
    ". Clone\n. Install\n. Build\n. Start\n",
  )
  expect(d.added).toEqual([[1, 2]])
  expect(d.removed).toEqual([])
})

test("returns a removed list item with where it was", async () => {
  const d = await diff("* Alpha\n* Beta\n* Gamma\n", "* Alpha\n* Gamma\n")
  expect(d.removed).toEqual([{ line: 1, text: "* Beta\n" }])
})

/** The HTML of the diff of two AsciiDoc texts, as the preview renders it */
async function rendered(prev: string, next: string) {
  const d = diffMarkdown(
    prev,
    next,
    await Promise.all([asciidocBlocks(prev), asciidocBlocks(next)]),
    ASCIIDOC,
  )
  return await renderAsciidoc(d.text, d.old)
}

test("keeps the space around a removed sentence", async () => {
  const html = await rendered(
    "Run the tests. They take a while. Most of it is the browser.\n",
    "Run the tests. Most of it is the browser.\n",
  )
  expect(html.replace(/<[^>]*>/g, "")).toContain("a while. Most")
})

test("a renamed section keeps its id", async () => {
  expect(await rendered("== Old name\n\nText.\n", "== New name\n\nText.\n")).toContain(
    'id="_new_name"',
  )
})

test("a description list's entries carry their lines", async () => {
  expect(stamps(await renderAsciidoc("CPU:: The brain.\nRAM:: Memory.\n"))).toContainEqual(
    expect.stringMatching(/ 1:2$/),
  )
})

test("a description list's terms and descriptions carry their lines, and a list in a description its own", async () => {
  expect(
    stamps(await renderAsciidoc("CPU::\n  The brain.\nRAM:: Memory.\n* one\n* two\n")),
  ).toEqual([
    "div 0:6",
    "dt 0:1",
    "dd 1:2",
    "dt 2:3",
    "dd 2:6",
    "div 3:6",
    "li 3:4",
    "li 4:6",
  ])
})

test("a removed listing keeps its attribute line, so it's highlighted the same", async () => {
  const prev = "Intro.\n\n[source,sh]\n----\nnpm install\n----\n"
  const next = "Intro.\n\n[source,sh]\n----\nnpm ci\n----\n"
  const d = diffMarkdown(
    prev,
    next,
    await Promise.all([asciidocBlocks(prev), asciidocBlocks(next)]),
    ASCIIDOC,
  )
  expect(d.removed).toEqual([{ line: 2, text: "[source,sh]\n----\nnpm install\n----\n" }])
  expect(d.added).toEqual([[2, 6]])
})

test("takes a removed description list entry whole", async () => {
  const prev = "CPU:: The brain.\nSSD:: Storage.\nRAM:: Memory.\n"
  const next = "CPU:: The brain.\nRAM:: Memory.\nGPU:: Draws the screen.\n"
  const d = diffMarkdown(
    prev,
    next,
    await Promise.all([asciidocBlocks(prev), asciidocBlocks(next)]),
    ASCIIDOC,
  )
  expect(d.removed).toEqual([{ line: 1, text: "SSD:: Storage.\n" }])
  expect(d.added).toEqual([[2, 3]])
  // A description's words, after the term, still go inline
  expect(await rendered("RAM:: Stores data.\n", "RAM:: Stores data briefly.\n")).toContain(
    '<ins class="diff-new">briefly</ins>',
  )
})
