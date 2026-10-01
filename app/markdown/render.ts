// The GitHub-flavored markdown renderer for <ah-markdown> (preview.ts), which
// adds its own rules on top, like conflict panels and GitHub embeds.

import MarkdownExit from "markdown-exit"
// @ts-expect-error no type declarations
import taskLists from "markdown-it-task-lists"

export function createMarkdown() {
  const md = MarkdownExit({ html: true, linkify: true }).use(taskLists)
  // Stamp block elements with their source line range so a page can match
  // blocks across re-renders (to flash what changed). Nested renders (conflict
  // panels) set env.nested, where the lines are meaningless.
  md.core.ruler.push("data_line", (state) => {
    if (state.env.nested) return true
    for (const token of state.tokens) {
      if (token.map && token.nesting !== -1) {
        token.attrSet("data-line", `${token.map[0]}:${token.map[1]}`)
      }
    }
    return true
  })
  return md
}
