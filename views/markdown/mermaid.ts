/// <reference lib="dom" />

// Mermaid, as a bundle of its own (/view/markdown/mermaid.js): it's bigger
// than everything else in the preview put together, so preview.ts loads it
// only once a file has a mermaid block.

import mermaid from "mermaid"

let count = 0

/** The SVG for a mermaid diagram's source, in the theme for the color
 * scheme. Throws mermaid's parse error for bad source. */
export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    // Flat like GitHub's, without neo's shadows and gradients
    look: "classic",
    // Throw instead of drawing the error into the page
    suppressErrorRendering: true,
  })
  const { svg } = await mermaid.render(`ah-mermaid-${count++}`, source)
  return svg
}
