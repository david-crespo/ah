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
  // YAML frontmatter, which GitHub shows as a table. Before hr, which would
  // take the opening ---.
  md.block.ruler.before("hr", "front_matter", (state, startLine, endLine, silent) => {
    const line = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n])
    if (startLine !== 0 || line(0) !== "---") return false
    let end = 1
    while (end < endLine && !/^(---|\.\.\.)$/.test(line(end))) end++
    if (end === endLine) return false
    if (silent) return true
    const token = state.push("front_matter", "", 0)
    token.map = [0, end + 1]
    token.content = state.getLines(1, end, 0, false)
    state.line = end + 1
    return true
  })
  md.renderer.rules.front_matter = (tokens, idx, _opts, env) => {
    const token = tokens[idx]
    const attrs = md.renderer.renderAttrs(token)
    const entries = frontMatterEntries(token.content)
    if (!entries) {
      return `<pre${attrs}><code class="language-yaml">${md.utils.escapeHtml(token.content)}</code></pre>\n`
    }
    const rows = entries.map(
      ([key, value]) =>
        `<tr><th>${md.utils.escapeHtml(key)}</th><td>${md.renderInline(value, env)}</td></tr>`,
    )
    return `<table class="front-matter"${attrs}><tbody>${rows.join("")}</tbody></table>\n`
  }
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
  // Linkify reads a URL from the rest of the paragraph, which would take in
  // a marker right after it
  const matchAtStart = md.linkify.matchAtStart.bind(md.linkify)
  md.linkify.matchAtStart = (text) => matchAtStart(text.split(MARKER)[0])
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

/** Frontmatter's top-level keys and their values, or null when it's more than
 * a flat map. A value continued on indented lines (a `|` or `>` block, or a
 * list) is joined into one line, the list's items with commas. */
export function frontMatterEntries(yaml: string): [string, string][] | null {
  const entries: [string, string[]][] = []
  for (const line of yaml.split("\n")) {
    const key = /^([\w-]+):(?:\s+(.*))?$/.exec(line)
    if (key) entries.push([key[1], key[2] && !/^[|>][-+]?$/.test(key[2]) ? [key[2]] : []])
    else if (/^\s+\S/.test(line) && entries.length) entries.at(-1)![1].push(line.trim())
    else if (line.trim()) return null
  }
  return entries.map(([key, lines]) => {
    const items = lines.every((l) => l.startsWith("- ")) && lines.length
    const parts = items ? lines.map((l) => unquote(l.slice(2))) : lines
    return [key, items ? parts.join(", ") : unquote(parts.join(" "))]
  })
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s)

// Either of diff.ts's inline markers
const MARKER = new RegExp(`${OPEN}|${CLOSE}`)

// GitHub shows a bare link to an issue, PR or discussion as its reference,
// owner/repo#123, adding "(comment)" when it points at a comment
const issueRe =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull|discussions)\/(\d+)(#issuecomment-\d+|#discussioncomment-\d+)?$/
