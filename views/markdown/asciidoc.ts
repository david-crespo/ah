// The AsciiDoc renderer for <ah-markdown> (preview.ts): Asciidoctor's html5
// output, with blocks stamped with their source lines the way render.ts
// stamps markdown's, so edit flashes and ⌘-click work the same. For the diff
// mode, the leaf blocks diff.ts diffs by, and its inline markers turned into
// the same marks render.ts makes.

import {
  type AbstractBlock,
  type AbstractNode,
  convert,
  type Document,
  Html5Converter,
  type List,
  load,
} from "@asciidoctor/core"
import { escapeHtml } from "../escape.ts"
import { type Block, CLOSE, OPEN } from "./diff.ts"

/** Each block's data-line: its 0-based source lines, "start:end" */
const blockLines = new WeakMap<AbstractNode, string>()

/** The html5 converter, adding a block's data-line to the first element it
 * writes, which is the block's outermost. Table cells are written by their
 * table rather than converted on their own, so the table is the finest block
 * there. List items are too, but each is a list's next unstamped <li>, or a
 * description list's <dt> and <dd>, since a nested list's were stamped as it
 * was converted. */
class LineConverter extends Html5Converter {
  override async convert(
    node: AbstractNode,
    transform?: string | null,
    opts?: object | null,
  ): Promise<unknown> {
    const out = await super.convert(node, transform, opts)
    const lines = blockLines.get(node)
    if (!lines || typeof out !== "string") return out
    let html = out
    const context = node.getContext()
    // A description list's items are each its terms and its description,
    // if it has one, unless it's written as a Q&A list or a table
    const dlist = context === "dlist" && html.includes("<dt")
    if (["ulist", "olist", "colist"].includes(context) || dlist) {
      const items = ((node as List).getItems() as unknown[])
        .flat(2)
        .filter(Boolean) as AbstractNode[]
      let i = 0
      html = html.replace(/<(?:li|dt|dd)(?![\w-]| data-line)/g, (tag) => {
        const item = blockLines.get(items[i++])
        return item ? `${tag} data-line="${item}"` : tag
      })
    }
    return html.replace(/^\s*<[a-z][\w-]*/i, (tag) => `${tag} data-line="${lines}"`)
  }
}

/** Whether `ancestor` holds `node`. The walk stops at the document, which
 * is its own parent. */
const isInside = (node: AbstractNode, ancestor: AbstractNode) => {
  for (let n = node; n.parent !== n; n = n.parent) if (n.parent === ancestor) return true
  return false
}

/** Record each block's lines: from its own line to the line of the next
 * block in the document that isn't inside it, or the end of the file */
function recordLines(doc: Document, lineCount: number) {
  const blocks: AbstractBlock[] = doc.findBy()
  blocks.forEach((block, i) => {
    if (block === doc || block.lineno == null) return
    let end = lineCount
    for (const next of blocks.slice(i + 1)) {
      if (next.lineno == null || isInside(next, block)) continue
      end = next.lineno - 1
      break
    }
    // A description list's term shares its line with the description
    blockLines.set(block, `${block.lineno - 1}:${Math.max(end, block.lineno)}`)
  })
}

/** The document's HTML, without a standalone page's header and footer.
 * Includes don't resolve: there's no file system in the page, so they show
 * as links. `old` is the diff mode's old words for the inline markers in
 * `text`, if it has any. */
export async function renderAsciidoc(text: string, old: string[] = []): Promise<string> {
  const doc = await load(text.replace(MARK, toPrivate), {
    sourcemap: true,
    converter: LineConverter,
    // The title shows, as on a page of its own, unless the file turns it off
    attributes: { showtitle: "@" },
  })
  recordLines(doc, text.split("\n").length)
  let html: string = await doc.convert()
  // The title isn't a block, so the converter doesn't stamp it
  const title = doc.hasHeader() ? doc.header?.lineno : null
  if (title != null)
    html = html.replace(/<h1(?=[ >])/, `<h1 data-line="${title - 1}:${title}"`)
  if (!html.includes(OPEN_PRIVATE) && !html.includes(CLOSE_PRIVATE)) return html
  const was = await Promise.all(old.map(inline))
  return html.replace(PRIVATE_MARK, (_, i?: string) => {
    if (i === undefined) return "</ins>"
    const del = was[fromPrivate(i)]
    return `${del ? `<del class="diff-old">${del}</del>` : ""}<ins class="diff-new">`
  })
}

/** Old words as inline HTML, with the space they start and end with, which
 * Asciidoctor would trim. Words it would take for a block come back as
 * text. */
async function inline(words: string): Promise<string> {
  const [, head, body, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(words)!
  if (!body) return ""
  const html = await convert(body, { doctype: "inline" })
  return head + (typeof html === "string" ? html : escapeHtml(body)) + tail
}

const escape = (s: string) => s.replace(/[{}]/g, "\\$&")
/** An inline marker, the opening one with its old words' index */
const MARK = new RegExp(`${escape(CLOSE)}|${escape(OPEN)}(\\d+)\\}`, "g")

// While Asciidoctor renders it, each marker is private-use characters only,
// the index's digits too: it drops those from the ids it makes from section
// titles, where digits and braces would change the id
const [OPEN_PRIVATE, CLOSE_PRIVATE, DIGIT_0] = ["\uf8f0", "\uf8f1", 0xf8e0]
const PRIVATE_MARK = new RegExp(`${CLOSE_PRIVATE}|${OPEN_PRIVATE}([\\uf8e0-\\uf8e9]+)`, "g")
const toPrivate = (_: string, i?: string) =>
  i === undefined
    ? CLOSE_PRIVATE
    : OPEN_PRIVATE + [...i].map((d) => String.fromCharCode(DIGIT_0 + Number(d))).join("")
const fromPrivate = (i: string) =>
  Number([...i].map((c) => c.charCodeAt(0) - DIGIT_0).join(""))

/** Contexts whose text the diff can mark inline: a paragraph, an admonition
 * written as one, a section's title and a list item's text. Any other leaf
 * is taken whole. */
const INLINE = new Set(["paragraph", "admonition", "section", "list_item"])

/** Lines that end a leaf without being part of it: blank ones, the next
 * block's attributes, title and comments, and the delimiter that closes
 * the block around it */
const TRAILING =
  /^\s*$|^\[.*\]\s*$|^\.[^.\s]|^\/\/|^:[\w-]+:|^(?:={4,}|-{4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\/{4,}|--|[|,:!]===)\s*$/

/** A block's attribute line, as `[source,sh]`, or its title, as `.Setup` */
const ATTRIBUTES = /^\[.*\]\s*$|^\.[^.\s]/

/** The leaf blocks of an AsciiDoc text, for diffMarkdown: a section's title
 * line, a list item's text, a table, and each block with no blocks in it,
 * from its line to the next block's, without the lines after it that are
 * TRAILING and with the ATTRIBUTES lines before it. A block's own closing
 * delimiter, the same as its first line, stays. */
export async function asciidocBlocks(text: string): Promise<Block[]> {
  const doc = await load(text, { sourcemap: true })
  const lines = text.split("\n")
  const all: AbstractBlock[] = doc.findBy()
  const leaves: Block[] = []
  all.forEach((block, i) => {
    const context = block.getContext()
    if (block.lineno == null || context === "table_cell") return
    const compound = block.getContentModel() === "compound"
    if (compound && !["section", "list_item", "table"].includes(context)) return
    const start = block.lineno - 1
    let end = start + 1
    if (context !== "section") {
      // The next block, which for a list item is one nested in it: its own
      // text ends there. A description list's term and its description can
      // share a line.
      const next = all
        .slice(i + 1)
        .find((b) => b.lineno != null && b.getContext() !== "table_cell")
      end = Math.max(start + 1, next?.lineno != null ? next.lineno - 1 : lines.length)
      while (end > start + 1 && TRAILING.test(lines[end - 1])) {
        if (lines[end - 1] === lines[start]) break
        end--
      }
    }
    // With the attribute and title lines right above it, as a listing's
    // [source,sh], so a removed one renders the same. A list's first item
    // leaves them to the list.
    let from = start
    if (context !== "list_item") while (from > 0 && ATTRIBUTES.test(lines[from - 1])) from--
    if (leaves.at(-1)?.start === from) return
    leaves.push({ start: from, end, opaque: !INLINE.has(context) })
  })
  return leaves
}
