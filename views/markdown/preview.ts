/// <reference lib="dom" />

// <ah-markdown src="/view/markdown/<id>/">: the live, read-only GFM preview
// of one open file, as a custom element so any ah page can hold one. The
// file page puts one next to its helix pane and comment popover (client.ts);
// the dashboard holds one per workspace. Every URL is resolved against
// `src` rather than the page's own location.
//
// No shadow DOM: the page's github-markdown.css and markdown.css style it,
// and page code can reach the rendered blocks (to anchor selection comments).
//
// The doc socket carries more than the text, so the element re-dispatches
// every message as a `doc-message` event and the socket closing as
// `doc-close`; `render` fires after each re-render. When the server says the
// file was closed, it notes that above the preview, stops reconnecting, and
// fires `closed`. While the server can't show the file, it says so and keeps
// trying, so the page comes back with the server, or the file.

import { languages } from "@codemirror/language-data"
import { LanguageDescription } from "@codemirror/language"
import { classHighlighter, highlightCode } from "@lezer/highlight"
import { createMarkdown } from "./render.ts"
import { type Conflict, findConflictEnd, parseConflict } from "./conflict.ts"
import type { ThreadSnapshot } from "../../subjects/thread/events.ts"
import { splice } from "./splice.ts"

/** What the doc socket sends: the text, the file's thread, and the
 * file closing */
export type DocMessage =
  | { type: "doc"; text: string }
  | { type: "closed" }
  | (ThreadSnapshot & { replay: boolean })

interface AhMarkdownEventMap extends HTMLElementEventMap {
  "doc-message": CustomEvent<DocMessage>
}

export class AhMarkdown extends HTMLElement {
  static observedAttributes = ["src"]

  /** The rendered file, an <article class="markdown-body"> */
  readonly content = document.createElement("article")
  #ws: WebSocket | null = null
  #text: string | null = null
  // 0-based [start, end) source line ranges to flash on the next render, with
  // the inserted source text so small edits can flash just the changed words
  #pendingFlash: { start: number; end: number; inserted: string }[] = []
  // Set once the server says the file was closed, so it stops reconnecting
  #closed = false
  #retry: ReturnType<typeof setTimeout> | undefined
  #mermaid = new MermaidDiagrams()
  // Diagrams are drawn for the color scheme, so a switch redraws them
  #scheme = matchMedia(DARK)
  #onScheme = () => {
    if (this.#text !== null) this.#render()
  }

  constructor() {
    super()
    this.content.className = "markdown-body"
  }

  // Gives `doc-message` listeners a typed event, as lib.dom does for its own
  // elements
  override addEventListener<K extends keyof AhMarkdownEventMap>(
    type: K,
    listener: (this: AhMarkdown, ev: AhMarkdownEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(type, listener, options)
  }

  /** The file's text as last rendered, or null before the first */
  get text(): string | null {
    return this.#text
  }

  /** The file's page URL, which every request is relative to */
  get base(): URL {
    return new URL(this.getAttribute("src") ?? "./", document.baseURI)
  }

  connectedCallback() {
    if (!this.content.isConnected) this.append(this.content)
    this.#scheme.addEventListener("change", this.#onScheme)
    this.#connect()
  }

  disconnectedCallback() {
    this.#scheme.removeEventListener("change", this.#onScheme)
    this.#disconnect()
  }

  attributeChangedCallback(_name: string, old: string | null, value: string | null) {
    if (old === value || !this.isConnected) return
    // A different file: start over, without flashing the whole new text
    this.#disconnect()
    this.#text = null
    this.#closed = false
    this.#note(null)
    this.content.replaceChildren()
    this.#connect()
  }

  #connect() {
    if (this.#ws || this.#closed) return
    const url = new URL("doc", this.base)
    url.protocol = "ws:"
    // Where this view is, for `ah view ls`: the dashboard marks its
    // elements, and `ah view open` the page's URL
    const where = this.getAttribute("in") ?? new URLSearchParams(location.search).get("in")
    if (where) url.searchParams.set("in", where)
    const ws = new WebSocket(url)
    this.#ws = ws
    ws.onopen = () => this.#note(null)
    ws.onmessage = (e) => {
      const msg: DocMessage = JSON.parse(e.data)
      if (msg.type === "doc") this.#apply(msg.text)
      if (msg.type === "closed") this.#showClosed()
      this.dispatchEvent(new CustomEvent<DocMessage>("doc-message", { detail: msg }))
    }
    ws.onclose = () => {
      if (this.#ws !== ws) return // replaced or disconnected on purpose
      this.#ws = null
      this.dispatchEvent(new Event("doc-close"))
      if (this.#closed) return
      void this.#explainClose()
      this.#retry = setTimeout(() => this.#connect(), 1000)
    }
  }

  /** A refused socket looks the same whether the server is down or the
   * file is gone, so ask for the page to tell them apart */
  async #explainClose() {
    const base = this.base.href
    let status: number
    try {
      status = (await fetch(base, { cache: "no-store" })).status
    } catch {
      status = 0
    }
    // Stale if the element moved on, connected, or closed meanwhile
    if (
      this.base.href !== base ||
      this.#ws?.readyState === WebSocket.OPEN ||
      this.#closed
    ) {
      return
    }
    if (status === 404) {
      this.#note(
        "ah can't show this file: it's gone, or ah's URL key changed. Open it again with ah view open.",
      )
    } else if (status === 0) {
      this.#note("Can't reach ah. Retrying…")
    }
  }

  /** The line above the preview saying why it isn't live; null clears it */
  #note(text: string | null) {
    let note = this.querySelector<HTMLElement>(".file-note")
    if (!text) return note?.remove()
    if (!note) {
      note = document.createElement("p")
      note.className = "file-note"
      this.content.before(note)
    }
    note.textContent = text
  }

  #disconnect() {
    clearTimeout(this.#retry)
    const ws = this.#ws
    this.#ws = null
    ws?.close()
  }

  #showClosed() {
    this.#closed = true
    this.#note("This file was closed. Open it again with ah view open.")
    this.dispatchEvent(new Event("closed"))
  }

  #apply(text: string) {
    if (this.#text !== null && text !== this.#text) {
      const { start, insert } = splice(this.#text, text)
      const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1
      // pure deletions still flash the block they happened in
      this.#pendingFlash.push({
        start: lineOf(start),
        end: lineOf(start + insert.length) + 1,
        inserted: insert,
      })
    }
    this.#text = text
    this.#render()
  }

  #render() {
    const content = this.content
    const toggled = toggledDetails(content)
    const embeds = hydratedEmbeds(content)
    content.innerHTML = md.render(this.#text ?? "")
    restoreDetails(content, toggled)
    markConflictChanges(content)
    highlightCodeBlocks(content)
    this.#mermaid.render(content, this.base)
    rewriteLocalMedia(content, this.base)
    hydrateEmbeds(content, this.base, embeds)
    const pending = this.#pendingFlash
    this.#pendingFlash = []
    if (pending.length > 0) {
      const els = [...content.querySelectorAll<HTMLElement>("[data-line]")]
      const hit = els.filter((el) => {
        const [s, e] = el.dataset.line!.split(":").map(Number)
        return pending.some((r) => s < r.end && e > r.start)
      })
      // flash only the innermost matching blocks; within one, flash just the
      // inserted text when it's small and locatable, else the whole block
      for (const el of hit) {
        if (hit.some((other) => other !== el && el.contains(other))) continue
        const [s, e] = el.dataset.line!.split(":").map(Number)
        const ranges = pending.filter((r) => s < r.end && e > r.start)
        let scoped = ranges.length > 0
        for (const r of ranges) {
          scoped = wrapText(el, r.inserted, "flash-inline") && scoped
        }
        if (!scoped) el.classList.add("flash")
      }
    }
    this.dispatchEvent(new Event("render"))
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ah-markdown": AhMarkdown
  }
}

// ---------- rendering ----------

// data-line attributes on blocks let remote-edit flashes find the right
// blocks after a re-render
const md = createMarkdown()

// jj/git conflict markers left in the file: render each side (and the base)
// as markdown in a labelled box instead of a wall of marker lines. Top level
// only, matching where jj writes them. `alt` lets a marker line interrupt a
// paragraph, since jj puts no blank line before it.
md.block.ruler.before(
  "table",
  "conflict",
  (state, startLine, endLine, silent) => {
    // Column 0 only. Inside a list item this runs as a terminator (silent), so
    // an unindented marker ends the item and the top-level pass renders it.
    if (state.tShift[startLine] > 0) return false
    const raw = (i: number) => state.src.slice(state.bMarks[i], state.eMarks[i])
    if (!raw(startLine).startsWith("<<<<<<<")) return false
    const lines: string[] = []
    for (let i = startLine; i < endLine; i++) lines.push(raw(i))
    const end = findConflictEnd(lines, 0)
    if (end < 0) return false
    if (silent) return true
    const token = state.push("conflict", "div", 0)
    token.block = true
    token.map = [startLine, startLine + end + 1]
    token.meta = parseConflict(lines, 0, end)
    state.line = startLine + end + 1
    return true
  },
  { alt: ["paragraph", "reference", "blockquote", "list"] },
)
md.renderer.rules.conflict = (tokens, idx, _opts, _env, self) => {
  const t = tokens[idx]
  const conflict: Conflict = t.meta
  const esc = md.utils.escapeHtml
  const panels = conflict.panels.map((p) => {
    const changed = p.changed?.length
      ? ` data-changed="${esc(JSON.stringify(p.changed))}"`
      : ""
    return (
      `<section class="conflict-panel" data-kind="${p.kind}"${changed}>` +
      `<div class="conflict-label">${esc(p.label)}</div>` +
      `<div class="conflict-body">${md.render(p.text, { nested: true })}</div></section>`
    )
  })
  return `<div${self.renderAttrs(t)} class="conflict"><div class="conflict-title">${esc(
    conflict.title,
  )}</div>${panels.join("")}</div>\n`
}

// In jj's diff-style markers the changed lines are known exactly; mark them
// in the rendered panels so a one-word difference doesn't hide in a paragraph.
function markConflictChanges(content: HTMLElement) {
  for (const panel of content.querySelectorAll<HTMLElement>(
    ".conflict-panel[data-changed]",
  )) {
    const body = panel.querySelector<HTMLElement>(".conflict-body")!
    const cls = panel.dataset.kind === "base" ? "conflict-removed" : "conflict-added"
    const lines = JSON.parse(panel.dataset.changed!) as string[]
    if (wrapText(body, lines.join("\n"), cls)) continue
    for (const line of lines) wrapText(body, line, cls)
  }
}

// A re-render replaces every <details>, so the reader's opening and closing
// would snap back on each edit. Remember which ones they toggled away from
// what the source says, matched across renders by summary text and
// occurrence, and toggle them again. Ones they didn't touch follow the
// source, so editing an `open` attribute still shows.
const sourceOpen = new WeakMap<HTMLDetailsElement, boolean>()

function keyedDetails(content: HTMLElement): [string, HTMLDetailsElement][] {
  const seen = new Map<string, number>()
  return [...content.querySelectorAll("details")].map((el) => {
    const summary = el.querySelector(":scope > summary")?.textContent?.trim() ?? ""
    const n = seen.get(summary) ?? 0
    seen.set(summary, n + 1)
    return [`${n}:${summary}`, el]
  })
}

function toggledDetails(content: HTMLElement): Map<string, boolean> {
  const toggled = new Map<string, boolean>()
  for (const [key, el] of keyedDetails(content)) {
    const source = sourceOpen.get(el)
    if (source !== undefined && el.open !== source) toggled.set(key, el.open)
  }
  return toggled
}

function restoreDetails(content: HTMLElement, toggled: Map<string, boolean>) {
  for (const [key, el] of keyedDetails(content)) {
    sourceOpen.set(el, el.open)
    const open = toggled.get(key)
    if (open !== undefined) el.open = open
  }
}

// GitHub expands two kinds of bare URL on their own line into embeds: a blob
// permalink with a line range becomes a code snippet, and a user-attachments
// asset becomes an image or video. Swap such paragraphs for a placeholder
// that hydrateEmbeds fills in after render.
const permalinkRe =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^#?]+)(?:\?[^#]*)?#L(\d+)(?:-L(\d+))?$/
const assetRe =
  /^https:\/\/(?:github\.com\/user-attachments\/assets\/|private-user-images\.githubusercontent\.com\/)\S+$/

md.core.ruler.push("gh_embed", (state) => {
  const toks = state.tokens
  for (let i = 0; i + 2 < toks.length; i++) {
    const [open, inline, close] = [toks[i], toks[i + 1], toks[i + 2]]
    if (open.type !== "paragraph_open" || close.type !== "paragraph_close") continue
    const kids = inline.children ?? []
    if (
      kids.length !== 3 ||
      kids[0].type !== "link_open" ||
      kids[2].type !== "link_close"
    ) {
      continue
    }
    const href = kids[0].attrGet("href") ?? ""
    if (kids[1].content !== href) continue
    if (!permalinkRe.test(href) && !assetRe.test(href)) continue
    const tok = new state.Token("gh_embed", "div", 0)
    tok.attrSet("class", "gh-embed")
    tok.attrSet("data-src", href)
    tok.map = open.map
    tok.block = true
    toks.splice(i, 3, tok)
  }
  return true
})
md.renderer.rules.gh_embed = (tokens, idx, _opts, _env, self) => {
  const t = tokens[idx]
  const href = t.attrGet("data-src") ?? ""
  // Placeholder degrades to the plain link until hydrated
  return `<div${self.renderAttrs(t)}><a href="${md.utils.escapeHtml(href)}">${md.utils.escapeHtml(
    href,
  )}</a></div>\n`
}

// Resolved embed contents, keyed by URL and shared by every element on the
// page. Permalinks are immutable and asset redirects stay valid long enough
// for a session, so nothing expires.
const embedCache = new Map<string, Promise<HTMLElement>>()

/** `base` is a file's page; the embed fetchers sit one level up, shared */
function buildEmbed(href: string, base: URL): Promise<HTMLElement> {
  let p = embedCache.get(href)
  if (!p) {
    p = (
      permalinkRe.test(href) ? buildBlobEmbed(href, base) : buildAssetEmbed(href, base)
    ).catch((e) => {
      embedCache.delete(href) // retry on next render
      const el = document.createElement("div")
      el.className = "gh-embed-error"
      el.textContent = `couldn't load embed: ${e instanceof Error ? e.message : e}`
      return el
    })
    embedCache.set(href, p)
  }
  return p
}

async function buildBlobEmbed(href: string, base: URL): Promise<HTMLElement> {
  const [, owner, repo, ref, path, startStr, endStr] = permalinkRe.exec(href)!
  const start = Number(startStr)
  const end = endStr ? Number(endStr) : start
  const q = new URLSearchParams({ owner, repo, ref, path })
  const res = await fetch(new URL(`../gh/blob?${q}`, base))
  if (!res.ok) throw new Error(await res.text())
  const lines = (await res.text()).split("\n").slice(start - 1, end)
  const code = lines.join("\n")

  const root = document.createElement("div")
  root.className = "gh-blob"
  const header = document.createElement("div")
  header.className = "gh-blob-header"
  const shortRef = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref
  header.innerHTML = `<a href="${md.utils.escapeHtml(href)}" target="_blank">${md.utils.escapeHtml(
    repo + "/" + path,
  )}</a> <span>${start === end ? `Line ${start}` : `Lines ${start} to ${end}`} in <code>${md.utils.escapeHtml(
    shortRef,
  )}</code></span>`
  const body = document.createElement("div")
  body.className = "gh-blob-body"
  const gutter = document.createElement("pre")
  gutter.className = "gh-blob-gutter"
  gutter.textContent = lines.map((_, i) => start + i).join("\n")
  const pre = document.createElement("pre")
  const codeEl = document.createElement("code")
  codeEl.textContent = code
  pre.append(codeEl)
  body.append(gutter, pre)
  root.append(header, body)
  const desc = LanguageDescription.matchFilename(languages, path)
  if (desc) await highlightElement(codeEl, desc, { detached: true })
  return root
}

async function buildAssetEmbed(href: string, base: URL): Promise<HTMLElement> {
  const res = await fetch(
    new URL(`../gh/asset?${new URLSearchParams({ url: href })}`, base),
  )
  if (!res.ok) throw new Error(await res.text())
  const { src, type } = (await res.json()) as { src: string; type: string }
  const video = () => {
    const v = document.createElement("video")
    v.src = src
    v.controls = true
    v.muted = true
    return v
  }
  if (type.startsWith("video/")) return video()
  const img = document.createElement("img")
  img.src = src
  img.alt = href
  // The type is inferred from the URL and may be missing; a failed image
  // load most likely means it was a video.
  if (!type) img.onerror = () => img.replaceWith(video())
  return img
}

/** The last render's loaded embeds by URL, to move into the next one. Failed
 * ones are left out so they retry. */
function hydratedEmbeds(content: HTMLElement): Map<string, Node[]> {
  const embeds = new Map<string, Node[]>()
  for (const el of content.querySelectorAll<HTMLElement>(".gh-embed.hydrated")) {
    const child = el.firstElementChild
    if (!child || child.classList.contains("gh-embed-error")) continue
    embeds.set(el.dataset.src!, [...(embeds.get(el.dataset.src!) ?? []), child])
  }
  return embeds
}

async function hydrateEmbeds(
  content: HTMLElement,
  base: URL,
  previous: Map<string, Node[]>,
) {
  // A fresh copy of an image or video has no size until it loads, so the
  // page above would shrink and the view jump on every re-render. Move the
  // loaded ones over before the browser paints.
  const fresh: HTMLElement[] = []
  for (const el of content.querySelectorAll<HTMLElement>(".gh-embed[data-src]")) {
    const old = previous.get(el.dataset.src!)?.shift()
    if (!old) {
      fresh.push(el)
      continue
    }
    el.replaceChildren(old)
    el.classList.add("hydrated")
  }
  for (const el of fresh) {
    const built = await buildEmbed(el.dataset.src!, base)
    if (!el.isConnected) continue // a re-render replaced this block mid-load
    el.replaceChildren(built.cloneNode(true))
    el.classList.add("hydrated")
  }
}

// Images and videos the file references by local path (screenshots not yet
// uploaded to GitHub) are served by the server, relative to the file.
function rewriteLocalMedia(content: HTMLElement, base: URL) {
  for (const el of content.querySelectorAll<HTMLElement>("img, video, source")) {
    const src = el.getAttribute("src")
    if (!src || /^(https?:|data:|blob:)/.test(src)) continue
    el.setAttribute(
      "src",
      new URL(`local?${new URLSearchParams({ path: src })}`, base).href,
    )
  }
}

// Fenced mermaid blocks render as diagrams, as on GitHub, drawn by mermaid.js
// (mermaid.ts), which loads the first time a file has one
const DARK = "(prefers-color-scheme: dark)"
type MermaidResult = { svg: string } | { error: string }
let mermaidModule: Promise<typeof import("./mermaid.ts")> | null = null

/** One <ah-markdown>'s diagrams. A render keeps the last one's drawings by
 * theme and source, so unchanged diagrams go back before the browser paints.
 * A diagram whose source changed shows its last drawing until the new one is
 * ready, so editing it doesn't flash its code, and source that doesn't parse
 * keeps the last drawing, with the error under it. */
class MermaidDiagrams {
  /** The latest render's drawings by key, and the draws it waits on */
  #results = new Map<string, MermaidResult>()
  #drawing = new Map<string, Promise<MermaidResult | null>>()
  #wanted = new Set<string>()
  /** Each block's last drawing, by its place among them */
  #lastSvgs: (string | null)[] = []
  /** Draws run one at a time, as mermaid's do anyway, so a draw for source a
   * newer render no longer has is skipped before it starts */
  #queue: Promise<unknown> = Promise.resolve()
  #keys = new WeakMap<HTMLElement, string>()

  /** Puts each block's code in a box that shows its drawing once there is one,
   * keeping the block's source lines for flashing and comments */
  render(content: HTMLElement, base: URL) {
    const dark = matchMedia(DARK).matches
    const blocks = [...content.querySelectorAll<HTMLElement>("pre > code.language-mermaid")]
    const keys = blocks.map((code) => `${dark}\n${code.textContent ?? ""}`)
    this.#wanted = new Set(keys)
    for (const key of this.#results.keys()) {
      if (!this.#wanted.has(key)) this.#results.delete(key)
    }
    const lastSvgs = this.#lastSvgs
    this.#lastSvgs = blocks.map((_, i) => lastSvgs[i] ?? null)
    blocks.forEach((code, i) => {
      const key = keys[i]
      const pre = code.parentElement!
      const box = document.createElement("div")
      box.className = "mermaid-diagram"
      if (code.dataset.line) box.dataset.line = code.dataset.line
      this.#keys.set(box, key)
      pre.replaceWith(box)
      box.append(pre)
      const done = this.#results.get(key)
      if (done) return this.#fill(box, i, done)
      const last = lastSvgs[i]
      if (last) this.#fill(box, i, { svg: last })
      void this.#draw(key, code.textContent ?? "", dark, base).then((result) => {
        if (!result) return
        // Into this block's box in whatever render is showing now
        content.querySelectorAll<HTMLElement>(".mermaid-diagram").forEach((el, j) => {
          if (this.#keys.get(el) === key) this.#fill(el, j, result)
        })
      })
    })
  }

  /** A drawing in place of what the box shows, or the error under it */
  #fill(box: HTMLElement, i: number, result: MermaidResult) {
    if ("svg" in result) {
      box.innerHTML = result.svg
      this.#lastSvgs[i] = result.svg
      return
    }
    let error = box.querySelector(".mermaid-error")
    if (!error) {
      error = document.createElement("div")
      error.className = "mermaid-error"
      box.append(error)
    }
    error.textContent = result.error
  }

  /** The drawing for `key`, or null if no render wants it by its turn */
  #draw(key: string, source: string, dark: boolean, base: URL) {
    let drawing = this.#drawing.get(key)
    if (drawing) return drawing
    drawing = this.#queue
      .then(async (): Promise<MermaidResult | null> => {
        if (!this.#wanted.has(key)) return null
        mermaidModule ??= import(
          /* @vite-ignore */ new URL("../mermaid.js", base).href
        ).catch((e) => {
          mermaidModule = null // retry on the next draw
          throw e
        })
        try {
          return { svg: await (await mermaidModule).renderMermaid(source, dark) }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      })
      .then((result) => {
        this.#drawing.delete(key)
        if (result && this.#wanted.has(key)) this.#results.set(key, result)
        return result
      })
    this.#drawing.set(key, drawing)
    this.#queue = drawing
    return drawing
  }
}

// Highlight fenced code blocks in the preview with lezer parsers from
// @codemirror/language-data; classHighlighter emits tok-* classes styled in
// markdown.css.
async function highlightCodeBlocks(content: HTMLElement) {
  for (const el of content.querySelectorAll<HTMLElement>(
    'pre > code[class*="language-"]',
  )) {
    const lang = /language-(\S+)/.exec(el.className)?.[1]
    if (!lang) continue
    const desc = LanguageDescription.matchLanguageName(languages, lang, true)
    if (desc) await highlightElement(el, desc)
  }
}

async function highlightElement(
  el: HTMLElement,
  desc: LanguageDescription,
  { detached = false } = {},
) {
  const support = await desc.load()
  if (!detached && !el.isConnected) return // a re-render replaced this block mid-load
  const code = el.textContent ?? ""
  const frag = document.createDocumentFragment()
  highlightCode(
    code,
    support.language.parser.parse(code),
    classHighlighter,
    (text, classes) => {
      if (classes) {
        const span = document.createElement("span")
        span.className = classes
        span.textContent = text
        frag.append(span)
      } else {
        frag.append(text)
      }
    },
    () => frag.append("\n"),
  )
  el.replaceChildren(frag)
}

// Find a piece of source text within a rendered block and wrap it in an
// inline span of the given class. Whitespace is stripped from both sides
// before matching (hard-wrapped source vs reflowed rendered text); a second
// attempt strips inline markdown markers. Returns false when the text can't
// be located or covers most of the block — callers fall back to marking the
// whole block.
function wrapText(el: HTMLElement, inserted: string, className: string): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const positions: { node: Text; offset: number }[] = []
  let haystack = ""
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    for (let i = 0; i < node.data.length; i++) {
      if (/\s/.test(node.data[i])) continue
      haystack += node.data[i]
      positions.push({ node, offset: i })
    }
  }
  const candidates = [inserted, inserted.replace(/[*_`~[\]]/g, "")].map((s) =>
    s.replace(/\s+/g, ""),
  )
  for (const needle of candidates) {
    // too short to locate reliably, or a rewrite of most of the block
    if (needle.length < 3 || needle.length >= 0.6 * haystack.length) return false
    const idx = haystack.indexOf(needle)
    if (idx < 0) continue
    const start = positions[idx]
    const end = positions[idx + needle.length - 1]
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset + 1)
    const span = document.createElement("span")
    span.className = className
    try {
      range.surroundContents(span)
    } catch {
      // range crosses element boundaries; extract-and-reinsert instead
      span.appendChild(range.extractContents())
      range.insertNode(span)
    }
    return true
  }
  return false
}

// Last, since defining it constructs the elements already on the page, and
// their fields need the classes and constants above
customElements.define("ah-markdown", AhMarkdown)
