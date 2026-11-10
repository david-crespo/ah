// A stack's files, which `ah tool stack` writes from the templates here: the
// page, only a frame that loads stack.js and stack.css, and the stack.json
// next to it that the agent fills in (data.ts). One directory per
// stack, since a page reloads on any change in its directory.

import { escapeHtml } from "../escape.ts"
import type { StackFile } from "./data.ts"

export function stackPage(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/stack.css">
<script type="module" src="/stack.js"></script>
</head>
<body>
<!-- Drawn from stack.json, next to this file -->
<main></main>
</body>
</html>
`
}

export function stackJson(title: string): string {
  const file: StackFile = { title, notes: [], prs: [] }
  return JSON.stringify(file, null, 2) + "\n"
}
