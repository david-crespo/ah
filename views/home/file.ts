// A home page's files, which `ah tool home` writes from the templates here:
// the page, only a frame that loads home.js and home.css, and the home.json
// next to it that the agent keeping the page fills in (data.ts).

import { escapeHtml } from "../escape.ts"
import type { HomeFile } from "./data.ts"

export function homePage(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/home.css">
<script type="module" src="/home.js"></script>
</head>
<body>
<!-- Drawn from home.json, next to this file -->
<main></main>
</body>
</html>
`
}

export function homeJson(title: string): string {
  const file: HomeFile = { title, projects: [], waiting: [], finished: [] }
  return JSON.stringify(file, null, 2) + "\n"
}
