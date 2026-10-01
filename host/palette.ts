// The terminal's look as CSS: colors and font from `ghostty +show-config`,
// which resolves the theme, so the page matches whatever Ghostty shows.

import { run } from "./proc.ts"

export interface Palette {
  background: string
  foreground: string
  /** 256 entries, indexed like the ANSI palette */
  colors: string[]
  fontFamily: string | null
  fontSize: number
}

export function parseConfig(config: string): Palette {
  const palette: Palette = {
    background: "#000000",
    foreground: "#ffffff",
    colors: [],
    fontFamily: null,
    fontSize: 13,
  }
  for (const line of config.split("\n")) {
    const m = line.match(/^([\w-]+) = (.*)$/)
    if (!m) continue
    const [, key, value] = m
    if (key === "background") palette.background = value
    else if (key === "foreground") palette.foreground = value
    else if (key === "font-family" && value && !palette.fontFamily) {
      palette.fontFamily = value
    } else if (key === "font-size") palette.fontSize = Number(value)
    else if (key === "palette") {
      const [index, color] = value.split("=")
      palette.colors[Number(index)] = color
    }
  }
  return palette
}

export async function readPalette(): Promise<Palette | null> {
  try {
    const { success, stdout } = await run("ghostty", ["+show-config"])
    return success ? parseConfig(stdout) : null
  } catch {
    return null
  }
}

export function paletteCss(p: Palette): string {
  const vars = [
    `--term-bg: ${p.background};`,
    `--term-fg: ${p.foreground};`,
    `--term-size: ${p.fontSize}px;`,
    ...p.colors.map((c, i) => (c ? `--ansi-${i}: ${c};` : "")).filter(Boolean),
  ]
  if (p.fontFamily) vars.push(`--term-font: "${p.fontFamily}", ui-monospace, monospace;`)
  return `:root {\n  ${vars.join("\n  ")}\n}`
}
