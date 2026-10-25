// The GitHub-flavored markdown renderer for <ah-markdown> (preview.ts), which
// adds its own rules on top, like conflict panels and GitHub embeds.

import MarkdownExit from "markdown-exit"
// @ts-expect-error no type declarations
import footnote from "markdown-it-footnote"
// @ts-expect-error no type declarations
import taskLists from "markdown-it-task-lists"

export function createMarkdown() {
  const md = MarkdownExit({ html: true, linkify: true }).use(taskLists).use(footnote)
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
  md.core.ruler.push("gh_issue_ref", (state) => {
    for (const tok of state.tokens) {
      const kids = tok.children ?? []
      for (let i = 0; i + 2 < kids.length; i++) {
        if (kids[i].type !== "link_open" || kids[i + 2].type !== "link_close") continue
        const href = kids[i].attrGet("href") ?? ""
        const m = issueRe.exec(href)
        if (!m || kids[i + 1].content !== href) continue
        kids[i + 1].content = `${m[1]}#${m[2]}${m[3] ? " (comment)" : ""}`
      }
    }
    return true
  })
  return md
}

// GitHub shows a bare link to an issue, PR or discussion as its reference,
// owner/repo#123, adding "(comment)" when it points at a comment
const issueRe =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull|discussions)\/(\d+)(#issuecomment-\d+|#discussioncomment-\d+)?$/
