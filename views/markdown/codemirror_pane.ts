/// <reference lib="dom" />

// The editor pane when the editor runs in the page (editor.ts): CodeMirror,
// with codemirror_backend.ts on the server to save. It's an example the user
// is trying out in place of Helix's terminal. It starts on the pane's first
// show, with the file's text as the preview element has it, and stays while
// the pane is hidden.
//
// Nothing uses it, and its packages aren't ah's dependencies. To try it,
// install them without saving them to package.json, and swap it in in
// files.ts and client.ts:
//
//   npm install --no-save codemirror@6.0.2 @codemirror/lang-markdown@6.5.2 \
//     @codemirror/view@6.43.15 @codemirror/state@6.7.6 \
//     @codemirror/theme-one-dark@6.1.3 node-diff3@3.2.1
//
// tsconfig.json leaves this file and merge.ts out, so ah typechecks without
// them.
//
// How it keeps to editor.ts's rules:
//
// - It saves 650ms after typing stops, when it loses focus, and on ⌘S. A save
//   carries its base, the file's text as of the last load or save, and the
//   server writes only over that.
// - The file on disk comes from the doc socket, by way of the preview
//   element, and from a save's reply when the file had moved on. With nothing
//   unsaved, the editor reloads. Otherwise it merges the file into the
//   unsaved text against the base (merge.ts), leaving overlaps as conflict
//   markers, and saves the result. While a save is out, a change on disk
//   waits for its reply, since it's most likely that save coming back.
// - The agent's edits don't go on the undo history, so ⌘Z only takes back
//   the user's own.

import { basicSetup } from "codemirror"
import { Prec, Transaction } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { languages } from "@codemirror/language-data"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { oneDark } from "@codemirror/theme-one-dark"
import { theme } from "../theme.ts"
import type { SaveReply } from "./codemirror_backend.ts"
import type { EditorPane } from "./editor.ts"
import { lineChanges, mergeDisk } from "./merge.ts"
import type { AhMarkdown } from "./preview.ts"

const SAVE_DELAY = 650

export class CodeMirrorPane implements EditorPane {
  readonly #host: HTMLElement
  readonly #socketUrl: string
  readonly #preview: AhMarkdown
  #started: Promise<EditorView> | null = null
  #view: EditorView | null = null
  /** The file's text as of the last load or save, which the unsaved text is
   * an edit of */
  #base = ""
  /** Opened on the first save, and again on the next one after it closes */
  #sock: WebSocket | null = null
  #saving: { id: number; text: string } | null = null
  #lastId = 0
  /** A save asked for while one was out, to send when its reply comes */
  #saveAgain = false
  /** The file as it came from the doc socket while a save was out */
  #held: string | null = null
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(host: HTMLElement, socketUrl: string, preview: AhMarkdown) {
    this.#host = host
    this.#socketUrl = socketUrl
    this.#preview = preview
  }

  show() {
    if (!this.#started) this.#started = this.#start()
    else this.#view?.focus()
  }

  /** The cursor at `line` and `column`, with that line level with `y`, staying
   * a fifth of the editor's height from either edge */
  async reveal(line: number, column: number, y: number) {
    const view = await this.#started
    if (!view) return
    const doc = view.state.doc
    const at = doc.line(Math.min(line + 1, doc.lines))
    const pos = at.from + Math.min(column, at.length)
    const box = view.scrollDOM.getBoundingClientRect()
    const margin = box.height / 5
    const level = Math.max(margin, Math.min(y - box.top, box.height - margin))
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, {
        y: "start",
        yMargin: level - view.defaultLineHeight / 2,
      }),
    })
    view.focus()
  }

  async #start(): Promise<EditorView> {
    // Listening first, so no change slips by between reading the text and
    // starting the editor
    let first: ((text: string) => void) | null = null
    this.#preview.addEventListener("doc-message", (e) => {
      if (e.detail.type !== "doc") return
      if (first) first(e.detail.text)
      else this.#takeDisk(e.detail.text)
    })
    const text =
      this.#preview.text ?? (await new Promise<string>((resolve) => (first = resolve)))
    first = null
    this.#base = text
    const view = new EditorView({
      doc: text,
      parent: this.#host,
      extensions: [
        Prec.highest(EditorView.domEventHandlers({ keydown: forPage })),
        keymap.of([{ key: "Mod-s", run: () => (this.#save(), true) }]),
        syntaxHighlighting(markdownStyle),
        basicSetup,
        // GFM (tables, strikethrough, task lists), with each fenced block's
        // language highlighted
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        EditorView.lineWrapping,
        oneDark,
        // Ahead of oneDark, whose styles would win otherwise
        Prec.high(paneTheme),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.#schedule()
          if (update.focusChanged && !update.view.hasFocus) this.#save()
        }),
      ],
    })
    this.#view = view
    view.focus()
    return view
  }

  #unsaved(): boolean {
    return this.#view !== null && this.#view.state.doc.toString() !== this.#base
  }

  /** A save once typing has stopped */
  #schedule() {
    clearTimeout(this.#timer)
    if (this.#unsaved()) this.#timer = setTimeout(() => this.#save(), SAVE_DELAY)
  }

  #save() {
    clearTimeout(this.#timer)
    const view = this.#view
    if (!view) return
    if (this.#saving) {
      this.#saveAgain = true
      return
    }
    const text = view.state.doc.toString()
    if (text === this.#base) return
    const ws = this.#socket()
    if (ws.readyState !== WebSocket.OPEN) return // saves once it's open
    this.#saving = { id: ++this.#lastId, text }
    ws.send(JSON.stringify({ type: "save", id: this.#lastId, base: this.#base, text }))
  }

  #socket(): WebSocket {
    if (this.#sock) return this.#sock
    const ws = new WebSocket(this.#socketUrl)
    this.#sock = ws
    ws.onopen = () => this.#save()
    ws.onmessage = (e) => this.#reply(JSON.parse(e.data) as SaveReply)
    ws.onclose = () => {
      this.#sock = null
      // A save that was out may or may not have been written. If it was, the
      // next one finds its own text on disk and merges that in, changing
      // nothing.
      this.#saving = null
      this.#saveAgain = false
      this.#takeHeld()
      // Keep trying while there's unsaved text, as while the server restarts
      if (this.#unsaved()) this.#timer = setTimeout(() => this.#save(), 1000)
    }
    return ws
  }

  #reply(msg: SaveReply) {
    if (msg.id !== this.#saving?.id) return
    const { text } = this.#saving
    this.#saving = null
    if (msg.type === "saved") this.#base = text
    else if (msg.type === "stale") this.#takeDisk(msg.text)
    else console.error(`ah: couldn't save: ${msg.error}`)
    this.#takeHeld()
    if (this.#saveAgain) {
      this.#saveAgain = false
      this.#save()
    } else if (msg.type !== "failed") this.#schedule()
  }

  #takeHeld() {
    const held = this.#held
    this.#held = null
    if (held !== null) this.#takeDisk(held)
  }

  /** The file on disk is `disk`: reload, or merge it into the unsaved text */
  #takeDisk(disk: string) {
    const view = this.#view
    if (!view || disk === this.#base) return
    if (this.#saving) {
      this.#held = disk
      return
    }
    const doc = view.state.doc.toString()
    let next = disk
    if (doc !== this.#base) {
      const merged = mergeDisk(this.#base, doc, disk)
      if (merged.conflict) console.warn("ah: merged the file on disk, with conflicts")
      next = merged.text
    }
    this.#base = disk
    if (next !== doc) {
      view.dispatch({
        changes: lineChanges(doc, next),
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      })
    }
    this.#schedule()
  }
}

/** ⌘-chords the page binds go to it instead (client.ts, find.ts, the
 * conversation): CodeMirror binds some of the same ones, ⌘F to its own search
 * and ⌘I to select the enclosing syntax node. Skipping CodeMirror without
 * preventDefault lets the event go on to the page. */
function forPage(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey) return false
  const key = e.key.toLowerCase()
  return e.shiftKey ? key === "c" || key === "g" : ["e", "f", "g", "i"].includes(key)
}

/** The markdown constructs themselves; each fenced block's language comes
 * with its own */
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "#61afef", textDecoration: "underline" },
  { tag: tags.url, color: "#61afef" },
  { tag: tags.monospace, color: "#e5c07b" },
  { tag: tags.quote, color: "#98c379" },
  // The #, *, - and > marks
  { tag: tags.processingInstruction, color: "#5c6370" },
])

/** The pane's background, so the editor meets its padding, and the
 * terminal's font */
const paneTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: theme.background,
      fontSize: `${theme.fontSize}px`,
    },
    ".cm-scroller": { fontFamily: theme.fontFamily },
    ".cm-gutters": { backgroundColor: theme.background },
    // Translucent: the active line paints over the selection
    ".cm-activeLine": { backgroundColor: "rgba(110, 118, 129, 0.12)" },
    ".cm-activeLineGutter": { backgroundColor: "#161b22" },
    // oneDark's own selector, since a simpler one loses on specificity
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#2d4a6d" },
  },
  { dark: true },
)
