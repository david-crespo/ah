import { expect, test } from "vitest"
import { createMarkdown } from "./render.ts"

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
