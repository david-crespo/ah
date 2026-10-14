// ANSI SGR escapes to HTML spans. The 16 theme colors become var(--ansi-N), so
// the page can paint them from the theme (see theme.ts).
// Other escape sequences are dropped. Box-drawing characters get wrapped so
// the page can draw them like Ghostty does (see box.ts).

import { wrapBoxes } from "../../host/box.ts"

interface Style {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

const plain = (): Style => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
})

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function css(style: Style): string {
  const out = []
  if (style.fg) out.push(`color:${style.fg}`)
  if (style.bg) out.push(`background:${style.bg}`)
  if (style.bold) out.push("font-weight:bold")
  if (style.dim) out.push("opacity:0.6")
  if (style.italic) out.push("font-style:italic")
  if (style.underline) out.push("text-decoration:underline")
  return out.join(";")
}

/** Indexed color n: a theme var for 0–15, else xterm's fixed cube and grays */
function indexed(n: number): string {
  if (n < 16) return `var(--ansi-${n})`
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return `rgb(${v},${v},${v})`
  }
  const level = (k: number) => (k ? 55 + 40 * k : 0)
  const j = n - 16
  return `rgb(${level(Math.floor(j / 36))},${level(Math.floor(j / 6) % 6)},${level(j % 6)})`
}

/** Consume an extended color (`5;n` or `2;r;g;b`) starting at codes[i]; returns [color, next index]. */
function extendedColor(codes: number[], i: number): [string | null, number] {
  if (codes[i] === 5) return [indexed(codes[i + 1]), i + 2]
  if (codes[i] === 2) {
    const [r, g, b] = codes.slice(i + 1, i + 4)
    return [`rgb(${r},${g},${b})`, i + 4]
  }
  return [null, i + 1]
}

function apply(style: Style, codes: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < codes.length;) {
    const c = codes[i++]
    if (c === 0) Object.assign(s, plain())
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 22) s.bold = s.dim = false
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c >= 30 && c <= 37) s.fg = `var(--ansi-${c - 30})`
    else if (c >= 90 && c <= 97) s.fg = `var(--ansi-${c - 90 + 8})`
    else if (c >= 40 && c <= 47) s.bg = `var(--ansi-${c - 40})`
    else if (c >= 100 && c <= 107) s.bg = `var(--ansi-${c - 100 + 8})`
    else if (c === 39) s.fg = null
    else if (c === 49) s.bg = null
    else if (c === 38) [s.fg, i] = extendedColor(codes, i)
    else if (c === 48) [s.bg, i] = extendedColor(codes, i)
  }
  return s
}

export function ansiToHtml(text: string): string {
  let out = ""
  let style = plain()
  // style of the span currently open in `out`, "" when none is
  let openAttr = ""
  // CSI sequences (SGR ends in m), plus OSC sequences ended by BEL or ST
  // oxlint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
  let last = 0
  // Spans open lazily, when there's text to put in them, so back-to-back
  // escapes don't leave empty spans and same-style runs share one
  const flush = (end: number) => {
    if (end <= last) return
    const attr = css(style)
    if (attr !== openAttr) {
      if (openAttr) out += "</span>"
      if (attr) out += `<span style="${attr}">`
      openAttr = attr
    }
    out += wrapBoxes(escapeHtml(text.slice(last, end)))
  }
  for (const m of text.matchAll(re)) {
    flush(m.index)
    last = m.index + m[0].length
    if (m[2] !== "m") continue
    const codes = m[1] === "" ? [0] : m[1].split(";").map((n) => Number(n || 0))
    style = apply(style, codes)
  }
  flush(text.length)
  if (openAttr) out += "</span>"
  return out
}
