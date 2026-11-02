import { expect, test } from "vitest"
import { renderAsciidoc } from "./asciidoc.ts"

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
    "div 10:13", // the list, with its items
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
