// The terminal's look, hard-coded to match the user's (ayu, Berkeley Mono).
// The dashboard gets it as CSS vars from /theme.css and the markdown page's
// helix terminal imports it. Indexed colors past 15 are xterm's fixed cube and
// grays, which ansi.ts computes.

export const theme = {
  background: "#020202",
  foreground: "#e6e1cf",
  fontFamily: '"Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  // ANSI colors 0–15
  ansi: [
    "#000000",
    "#ff5555",
    "#b8cc52",
    "#e7c547",
    "#36a3d9",
    "#f07178",
    "#95e6cb",
    "#ffffff",
    "#686868",
    "#ff6565",
    "#eafe84",
    "#fff779",
    "#68d5ff",
    "#ffa3aa",
    "#c7fffd",
    "#ffffff",
  ],
}

export function themeCss(): string {
  const vars = [
    `--term-bg: ${theme.background};`,
    `--term-fg: ${theme.foreground};`,
    `--term-font: ${theme.fontFamily};`,
    `--term-size: ${theme.fontSize}px;`,
    ...theme.ansi.map((c, i) => `--ansi-${i}: ${c};`),
  ]
  return `:root {\n  ${vars.join("\n  ")}\n}\n`
}
