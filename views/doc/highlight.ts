/// <reference lib="dom" />

// Syntax highlighting for code in the preview, with lezer parsers from
// @codemirror/language-data: its fenced code blocks (preview.ts) and the
// snippets of GitHub permalinks (embeds.ts). classHighlighter emits tok-*
// classes styled in markdown.css.

import { languages } from "@codemirror/language-data"
import { LanguageDescription } from "@codemirror/language"
import { classHighlighter, highlightCode } from "@lezer/highlight"

export async function highlightCodeBlocks(content: HTMLElement) {
  for (const el of content.querySelectorAll<HTMLElement>(
    'pre > code[class*="language-"]',
  )) {
    const lang = /language-(\S+)/.exec(el.className)?.[1]
    if (!lang) continue
    const desc = LanguageDescription.matchLanguageName(languages, lang, true)
    if (desc) await highlightElement(el, desc)
  }
}

export async function highlightElement(
  el: HTMLElement,
  desc: LanguageDescription,
  { detached = false } = {},
) {
  const support = await desc.load()
  if (!detached && !el.isConnected) return // a re-render replaced this block mid-load
  const code = el.textContent ?? ""
  const frag = document.createDocumentFragment()
  highlightCode(
    code,
    support.language.parser.parse(code),
    classHighlighter,
    (text, classes) => {
      if (classes) {
        const span = document.createElement("span")
        span.className = classes
        span.textContent = text
        frag.append(span)
      } else {
        frag.append(text)
      }
    },
    () => frag.append("\n"),
  )
  el.replaceChildren(frag)
}
