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

test("diff marks and conflict sides don't repeat the document's footnotes", () => {
  const notes = "\n\n[^a]: A note\n"
  const sections = (html: string) => html.match(/<section class="footnotes"/g)
  expect(sections(md.render(`Text.[^a] {~~one~>two~~}${notes}`))).toHaveLength(1)
  const marked = `Text.[^a] ${OPEN}0}new${CLOSE}${notes}`
  expect(sections(md.render(marked, { diff: { old: ["old"] } }))).toHaveLength(1)
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

test("a conflict renders each side as markdown in a labelled panel", () => {
  const html = md.render(
    "Intro.\n<<<<<<< HEAD\n**ours**\n=======\ntheirs\n>>>>>>> feature\nAfter.\n",
  )
  expect(html).toContain('<p data-line="0:1">Intro.</p>')
  expect(html).toContain(
    '<div data-line="1:6" class="conflict"><div class="conflict-title">Merge conflict</div>' +
      '<section class="conflict-panel" data-kind="side"><div class="conflict-label">HEAD</div>' +
      '<div class="conflict-body"><p><strong>ours</strong></p>\n</div></section>',
  )
  expect(html).toContain('<div class="conflict-label">feature</div>')
  expect(html).toContain('<p data-line="6:7">After.</p>')
})

test("a jj conflict's panels say which lines changed", () => {
  const html = md.render(
    [
      "<<<<<<< conflict 1 of 1",
      "%%%%%%% diff from: base",
      "\\\\\\\\\\\\\\        to: side #1",
      "-old line",
      "+new line",
      "+++++++ side #2",
      "other",
      ">>>>>>> conflict 1 of 1 ends",
    ].join("\n"),
  )
  expect(html).toContain(
    '<section class="conflict-panel" data-kind="side" data-changed="[&quot;new line&quot;]">',
  )
  expect(html).toContain(
    '<section class="conflict-panel" data-kind="base" data-changed="[&quot;old line&quot;]">',
  )
})

test("the editor pane's merge sides get buttons that pick them", () => {
  const html = md.render("<<<<<<< mine\nA\n=======\nB\n>>>>>>> agent\n")
  for (const side of ["mine", "agent"])
    expect(html).toContain(
      `<section class="conflict-panel" data-kind="side" data-side="${side}"><button class="conflict-label merge-pick" data-side="${side}"></button>`,
    )
})

test("a bare GitHub permalink or asset on its own line is an embed's placeholder", () => {
  const permalink = "https://github.com/o/r/blob/0123456/a.ts#L1-L3"
  expect(md.render(`${permalink}\n`)).toBe(
    `<div class="gh-embed" data-src="${permalink}"><a href="${permalink}">${permalink}</a></div>\n`,
  )
  const asset = "https://github.com/user-attachments/assets/abc"
  expect(md.render(`${asset}\n`)).toContain(`class="gh-embed" data-src="${asset}"`)
  expect(md.render(`see ${permalink}\n`)).not.toContain("gh-embed")
})
