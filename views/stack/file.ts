// A stack's files, which `ah tool stack` writes from the templates here: the
// page, only a frame that loads stack.js and stack.css, and unless `jjack
// init` wrote it first, the stack.json next to it for the agent to fill in
// (data.ts). One directory per stack, since a page reloads on any change in
// its directory.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { escapeHtml } from "../escape.ts"
import { STACK_FILE, type StackFile } from "./data.ts"

export type FoundStack = { page: string; title: string; modified: number }

/** The stack pages (an index.html with a stack.json next to it) one level
 * down in each of `notesDirs`, which may be symlinks, most recently changed
 * first. A page changed when its index.html or stack.json did. */
export function findStacks(notesDirs: string[]): FoundStack[] {
  const found = new Map<string, FoundStack>()
  for (const notes of notesDirs) {
    let names: string[]
    try {
      names = readdirSync(notes)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const page = realpathSync(join(notes, name, "index.html"))
        const json = join(page, "..", STACK_FILE)
        const modified = Math.max(statSync(page).mtimeMs, statSync(json).mtimeMs)
        let title = name
        try {
          title = JSON.parse(readFileSync(json, "utf8")).title ?? name
        } catch {
          // a stack.json being rewritten: the directory's name will do
        }
        found.set(page, { page, title: String(title), modified })
      } catch {
        // not a stack directory
      }
    }
  }
  return [...found.values()].sort((a, b) => b.modified - a.modified)
}

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
