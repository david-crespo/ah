// Box-drawing characters drawn as cell-filling lines, the way Ghostty draws
// them instead of using the font's glyphs. With font glyphs, a line height
// taller than the glyph leaves gaps between rows of the jj graph and corners
// that don't meet. Each character becomes a span one cell wide and one line
// tall, painted with an SVG mask in the text's color; the character stays
// underneath (transparent) so copying still works.

// Which cell edges each character connects; "~" marks a rounded corner
const BOXES: Record<string, string> = {
  "│": "ud",
  "─": "lr",
  "├": "udr",
  "┤": "udl",
  "┬": "dlr",
  "┴": "ulr",
  "┼": "udlr",
  "┌": "dr",
  "┐": "dl",
  "└": "ur",
  "┘": "ul",
  "╭": "dr~",
  "╮": "dl~",
  "╰": "ur~",
  "╯": "ul~",
}

// The cell is a 10×20 viewBox stretched to 1ch × 1lh
const EDGE: Record<string, string> = { u: "5,0", d: "5,20", l: "0,10", r: "10,10" }
const NEAR: Record<string, string> = { u: "5,6", d: "5,14", l: "1,10", r: "9,10" }
const OPPOSITE: Record<string, string> = { u: "d", d: "u", l: "r", r: "l" }

function path(spec: string): string {
  const dirs = [...spec.replace("~", "")]
  if (spec.endsWith("~")) {
    const [a, b] = dirs
    return `M${EDGE[a]} L${NEAR[a]} Q5,10 ${NEAR[b]} L${EDGE[b]}`
  }
  const parts = []
  if (dirs.includes("u") && dirs.includes("d")) parts.push("M5,0 L5,20")
  if (dirs.includes("l") && dirs.includes("r")) parts.push("M0,10 L10,10")
  const stubs = dirs.filter((d) => !dirs.includes(OPPOSITE[d]))
  if (stubs.length === 2) parts.push(`M${EDGE[stubs[0]]} L5,10 L${EDGE[stubs[1]]}`)
  if (stubs.length === 1) parts.push(`M5,10 L${EDGE[stubs[0]]}`)
  return parts.join(" ")
}

const className = (char: string) => `bx-${char.codePointAt(0)!.toString(16)}`

export function boxCss(): string {
  const rules = Object.entries(BOXES).map(([char, spec]) => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" ` +
      `preserveAspectRatio="none"><path d="${path(spec)}" fill="none" stroke="black" ` +
      `stroke-width="1.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
    return `.${className(char)} { --bx: url("data:image/svg+xml,${encodeURIComponent(
      svg,
    )}"); }`
  })
  return `.bx {
  display: inline-block;
  width: 1ch;
  height: 1lh;
  vertical-align: top;
  -webkit-text-fill-color: transparent;
  background-color: currentColor;
  mask: var(--bx) center / 100% 100% no-repeat;
}
${rules.join("\n")}`
}

const BOX_RE = new RegExp(`[${Object.keys(BOXES).join("")}]`, "g")

/** Wrap box-drawing characters in already-escaped HTML text. */
export function wrapBoxes(html: string): string {
  return html.replace(BOX_RE, (c) => `<span class="bx ${className(c)}">${c}</span>`)
}
