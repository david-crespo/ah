import { expect, test } from "vitest"
import { CLOSE, OPEN } from "./diff.ts"
import { createMarkdown, frontMatterEntries } from "./render.ts"

const md = createMarkdown()
const inline = (text: string) => md.renderInline(text)

test("a bare link to an issue, PR or discussion shows as its reference", () => {
  expect(inline("see https://github.com/anthropics/claude-code/issues/96959")).toBe(
    'see <a href="https://github.com/anthropics/claude-code/issues/96959">anthropics/claude-code#96959</a>',
  )
  expect(inline("<https://github.com/oxidecomputer/omicron/pull/4669>")).toContain(
    ">oxidecomputer/omicron#4669</a>",
  )
  expect(inline("https://github.com/o/r/discussions/12")).toContain(">o/r#12</a>")
  expect(inline("https://github.com/o/r/issues/1#issuecomment-99")).toContain(
    ">o/r#1 (comment)</a>",
  )
})

test("other links keep their text", () => {
  expect(inline("[the bug](https://github.com/o/r/issues/1)")).toContain(">the bug</a>")
  expect(inline("https://github.com/o/r/pull/1/files")).toContain(
    ">https://github.com/o/r/pull/1/files</a>",
  )
  expect(inline("https://github.com/o/r/issues")).toContain(
    ">https://github.com/o/r/issues</a>",
  )
})

test("a merge conflict shows both versions, each as markdown", () => {
  const pick = (side: string) => `<button class="merge-pick" data-side="${side}"></button>`
  expect(inline("Merges are {~~**fast**~>`inexpensive`~~}, so")).toBe(
    `Merges are <span class="merge-conflict" data-source="{~~**fast**~&gt;\`inexpensive\`~~}" data-nth="0"><span class="merge-mine">${pick("mine")}<strong>fast</strong></span><span class="merge-agent">${pick("agent")}<code>inexpensive</code></span></span>, so`,
  )
  expect(inline("one {~~two.~>~~} three")).toContain(
    `<span class="merge-agent" data-empty>${pick("agent")}</span>`,
  )
  expect(md.render("# {~~Saved~>Stored~~} sessions")).toContain(
    `<span class="merge-mine">${pick("mine")}Saved</span>`,
  )
  expect(inline("~~struck~~ and {~~unclosed")).toBe("<s>struck</s> and {~~unclosed")
})

test("a merge conflict says which of the same ones it is", () => {
  const nths = [
    ...md.render("{~~a~>b~~} {~~c~>d~~}\n\n{~~a~>b~~}").matchAll(/data-nth="(\d)"/g),
  ]
  expect(nths.map((m) => m[1])).toEqual(["0", "0", "1"])
})

test("frontmatter shows as a table of its keys", () => {
  const html = md.render(
    "---\nname: matrix\ndescription: Read and search\n  message history\n---\n\n# matrix\n",
  )
  expect(html).toContain(
    '<table class="front-matter" data-line="0:5"><tbody><tr><th>name</th><td>matrix</td></tr><tr><th>description</th><td>Read and search message history</td></tr></tbody></table>',
  )
  expect(html).toContain('<h1 data-line="6:7">matrix</h1>')
  expect(html).not.toContain("<hr")
})

test("frontmatter cells don't repeat the document's footnotes", () => {
  const html = md.render("---\ntitle: Skills\n---\n\nText.[^a]\n\n[^a]: A note\n")
  expect(html.match(/<section class="footnotes"/g)).toHaveLength(1)
})

test("frontmatter that isn't a flat map shows as YAML", () => {
  expect(md.render("---\na:\n  b: c\n# note\n---\n")).toContain(
    '<pre data-line="0:5"><code class="language-yaml">a:\n  b: c\n# note</code></pre>',
  )
})

test("a --- that doesn't open the file, or isn't closed, is a rule", () => {
  expect(md.render("text\n\n---\na: b\n---\n")).toContain("<hr")
  expect(md.render("---\na: b\n")).toContain("<hr")
})

test("frontmatter values join their lines, lists with commas", () => {
  expect(frontMatterEntries("a: >-\n  one\n  two\nb:\n  - x\n  - \"y\"\nc: 'q'\n")).toEqual(
    [
      ["a", "one two"],
      ["b", "x, y"],
      ["c", "q"],
    ],
  )
})

test("a URL ends before a diff marker after it", () => {
  const html = md.render(`See ${OPEN}0}https://a.com/y${CLOSE}.`, {
    diff: { old: ["https://a.com/x"] },
  })
  expect(html).toContain(
    '<ins class="diff-new"><a href="https://a.com/y">https://a.com/y</a></ins>.',
  )
})
