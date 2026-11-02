// The GitHub-flavored markdown renderer for <ah-markdown> (preview.ts), which
// adds its own rules on top, like conflict panels and GitHub embeds.

import MarkdownExit from "markdown-exit"
import { CLOSE, OPEN } from "./diff.ts"
import { AGENT, MINE } from "./merge.ts"
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
  // Both versions of text the user and the agent both changed, as the editor
  // pane's merge marks them (merge.ts): CriticMarkup's substitution,
  // {~~mine~>agent's~~}. Before strikethrough, which would take the ~~.
  md.inline.ruler.before("strikethrough", "merge_conflict", (state, silent) => {
    const { src, pos } = state
    if (!src.startsWith("{~~", pos)) return false
    const mid = src.indexOf("~>", pos + 3)
    const end = mid < 0 ? -1 : src.indexOf("~~}", mid + 2)
    if (end < 0) return false
    if (!silent) {
      state.push("merge_conflict", "", 0).meta = {
        source: src.slice(pos, end + 3),
        mine: src.slice(pos + 3, mid),
        agent: src.slice(mid + 2, end),
      }
    }
    state.pos = end + 3
    return true
  })
  // Each side's label is a button that picks it (preview.ts), labelled by
  // CSS so the label isn't in the text. The marker's source, and which of the
  // markers with that source it is, say where it is in the file.
  md.renderer.rules.merge_conflict = (tokens, idx, _opts, env) => {
    const { source, mine, agent } = tokens[idx].meta
    const seen: Map<string, number> = (env.mergeConflicts ??= new Map())
    const nth = seen.get(source) ?? 0
    seen.set(source, nth + 1)
    const side = (name: string, text: string) =>
      `<span class="merge-${name}"${text ? "" : " data-empty"}><button class="merge-pick" data-side="${name}"></button>${md.renderInline(text, env)}</span>`
    return `<span class="merge-conflict" data-source="${md.utils.escapeHtml(source)}" data-nth="${nth}">${side(MINE, mine)}${side(AGENT, agent)}</span>`
  }
  // The diff mode's marks around changed words (diff.ts): the old words,
  // from env.diff, then the new ones, which parse as part of their paragraph
  md.inline.ruler.before("strikethrough", "diff_mark", (state, silent) => {
    const { src, pos } = state
    if (src.startsWith(CLOSE, pos)) {
      if (!silent) state.push("diff_close", "ins", -1)
      state.pos += CLOSE.length
      return true
    }
    if (!src.startsWith(OPEN, pos)) return false
    const end = src.indexOf("}", pos + OPEN.length)
    if (!silent) {
      const index = Number(src.slice(pos + OPEN.length, end))
      state.push("diff_open", "ins", 1).meta = { old: state.env.diff?.old[index] ?? "" }
    }
    state.pos = end + 1
    return true
  })
  md.renderer.rules.diff_open = (tokens, idx, _opts, env) => {
    const { old } = tokens[idx].meta
    const del = old ? `<del class="diff-old">${md.renderInline(old, env)}</del>` : ""
    return `${del}<ins class="diff-new">`
  }
  md.renderer.rules.diff_close = () => "</ins>"
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
