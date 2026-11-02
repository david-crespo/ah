// The AsciiDoc renderer for <ah-markdown> (preview.ts): Asciidoctor's html5
// output, with blocks stamped with their source lines the way render.ts
// stamps markdown's, so edit flashes and ⌘-click work the same.

import {
  type AbstractBlock,
  type AbstractNode,
  type Document,
  Html5Converter,
  load,
} from "@asciidoctor/core"

/** Each block's data-line: its 0-based source lines, "start:end" */
const blockLines = new WeakMap<AbstractNode, string>()

/** The html5 converter, adding a block's data-line to the first element it
 * writes, which is the block's outermost. List items and table cells are
 * written by their list or table rather than converted on their own, so the
 * list or table is the finest block there. */
class LineConverter extends Html5Converter {
  override async convert(
    node: AbstractNode,
    transform?: string | null,
    opts?: object | null,
  ): Promise<unknown> {
    const html = await super.convert(node, transform, opts)
    const lines = blockLines.get(node)
    if (!lines || typeof html !== "string") return html
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
    blockLines.set(block, `${block.lineno - 1}:${end}`)
  })
}

/** The document's HTML, without a standalone page's header and footer.
 * Includes don't resolve: there's no file system in the page, so they show
 * as links. */
export async function renderAsciidoc(text: string): Promise<string> {
  const doc = await load(text, {
    sourcemap: true,
    converter: LineConverter,
    // The title shows, as on a page of its own, unless the file turns it off
    attributes: { showtitle: "@" },
  })
  recordLines(doc, text.split("\n").length)
  const html: string = await doc.convert()
  // The title isn't a block, so the converter doesn't stamp it
  const title = doc.hasHeader() ? doc.header?.lineno : null
  return title == null
    ? html
    : html.replace(/<h1(?=[ >])/, `<h1 data-line="${title - 1}:${title}"`)
}
