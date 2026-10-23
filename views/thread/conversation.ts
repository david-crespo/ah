/// <reference lib="dom" />
import MarkdownExit from "markdown-exit"
import type { Request, ThreadEntry } from "../../core/model.ts"
import type {
  ThreadSnapshot,
  RequestInput,
  RequestKinds,
  RequestResult,
} from "../../subjects/thread/events.ts"

// Feed messages need Markdown, but not raw HTML, embeds or remote image loads.
const markdown = new MarkdownExit({ html: false, linkify: true, breaks: true })
markdown.disable("image")

/** Focus an element that was hidden until this task, once a frame has rendered
 * it. Focused in the same task, it gets DOM focus but Chrome's accessibility
 * tree keeps reporting the old element, so dictation tools that insert text
 * through accessibility (MacWhisper) miss it. */
export function focusWhenRendered(element: HTMLElement) {
  requestAnimationFrame(() => requestAnimationFrame(() => element.focus()))
}

/** What the feed labels a request with and shows for it */
function describe(request: Request, kinds: RequestKinds): { label?: string; body: string } {
  const { kind, text, args } = request
  return (
    kinds[kind]?.feed?.(request) ?? {
      label: kind,
      body: text || Object.values(args).join(": "),
    }
  )
}

export class Conversation {
  readonly element = document.createElement("section")
  private feed: HTMLElement
  private form: HTMLFormElement
  private input: HTMLTextAreaElement
  private toggle: HTMLButtonElement
  private status: HTMLElement
  private error: HTMLElement
  private empty: HTMLElement
  private newMessages: HTMLButtonElement
  private dock: HTMLElement
  private offline: HTMLElement
  private snapshot: ThreadSnapshot | null = null
  private rows = new Map<string, HTMLElement>()
  private read = new Set<string>()
  private toasts = new Map<string, number>()
  private connected = false
  private open = false
  private paused = false
  private selectionActive = false
  private sending = false
  private lastTick = Date.now()
  /** Where focus was when the shortcut opened the conversation, to go back
   * to when it closes */
  private returnFocus: HTMLElement | null = null

  private onOpen: () => void
  private kinds: RequestKinds
  private threadUrl: string

  /** `kinds` are the requests the page's file type takes, for showing them.
   * `threadUrl` is where the thread's routes are (subjects/thread/routes.ts);
   * by default, relative to the page. */
  constructor(onOpen: () => void, kinds: RequestKinds, threadUrl = location.href) {
    this.onOpen = onOpen
    this.kinds = kinds
    this.threadUrl = threadUrl
    this.element.id = "conversation"
    this.element.setAttribute("aria-label", "Conversation")
    this.element.innerHTML = `
      <div class="conversation-feed" id="conversation-history" role="region" aria-label="Conversation history"></div>
      <div class="conversation-dock">
      <p class="conversation-empty" hidden>Ask a question or leave a comment on the document.</p>
      <button class="conversation-new" type="button" hidden>New messages ↓</button>
      <p class="conversation-error" role="alert" hidden></p>
      <div class="conversation-status" role="status"><span class="conversation-status-spinner" aria-hidden="true"></span><span class="conversation-status-text"></span></div>
      <div class="conversation-controls">
        <span class="conversation-offline" hidden></span>
        <form class="conversation-compose" hidden>
          <textarea rows="1" aria-label="Message the agent" placeholder="Reply"></textarea>
          <button class="conversation-send" type="submit" aria-label="Send" title="Send (Enter; Shift+Enter for newline)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3v5a2 2 0 0 1-2 2h-9m3-3-3 3 3 3"/></svg>
          </button>
        </form>
        <button class="conversation-toggle" type="button" aria-expanded="false" aria-controls="conversation-history" aria-label="Open conversation" aria-keyshortcuts="Meta+I Control+I">
          <span class="conversation-spinner" aria-hidden="true"></span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>
          <span class="conversation-agent" aria-hidden="true"></span>
        </button>
      </div>
      </div>`
    document.body.append(this.element)
    this.feed = this.element.querySelector(".conversation-feed")!
    this.form = this.element.querySelector("form")!
    this.input = this.element.querySelector("textarea")!
    this.toggle = this.element.querySelector(".conversation-toggle")!
    this.status = this.element.querySelector(".conversation-status")!
    this.error = this.element.querySelector(".conversation-error")!
    this.empty = this.element.querySelector(".conversation-empty")!
    this.newMessages = this.element.querySelector(".conversation-new")!
    this.dock = this.element.querySelector(".conversation-dock")!
    // Open, the dock floats over the feed's bottom, which leaves room for it
    // to scroll the last message clear
    new ResizeObserver(() => {
      const bottom = this.atBottom()
      this.element.style.setProperty("--dock-height", `${this.dock.offsetHeight}px`)
      if (this.open && bottom) this.feed.scrollTop = this.feed.scrollHeight
    }).observe(this.dock)
    this.offline = this.element.querySelector(".conversation-offline")!
    this.toggle.addEventListener("click", () => this.setOpen(!this.open))
    this.form.addEventListener("submit", (event) => {
      event.preventDefault()
      void this.submit()
    })
    this.input.addEventListener("input", () => {
      this.fitInput()
      this.saveDraft()
    })
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.open) {
        event.preventDefault()
        this.setOpen(false)
      }
      // Enter sends and Shift+Enter is a new line, as in a chat app. Not
      // while an IME is composing, where Enter picks the candidate.
      if (
        event.target === this.input &&
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        event.preventDefault()
        void this.submit()
      }
    })
    // ⌘I toggles the conversation from anywhere on the page, the editor pane
    // included (it passes ⌘-chords it doesn't bind to the page). Ctrl+I for
    // terminal-browser panes, where cmd chords may not arrive.
    document.addEventListener("keydown", (event) => {
      if (
        event.key.toLowerCase() === "i" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault()
        if (!this.open) {
          const active = document.activeElement
          this.returnFocus =
            active instanceof HTMLElement && active !== document.body ? active : null
        }
        this.setOpen(!this.open)
      }
    })
    this.feed.addEventListener("scroll", () => {
      if (this.atBottom()) this.newMessages.hidden = true
      this.markRead()
    })
    this.newMessages.addEventListener("click", () => {
      this.feed.scrollTop = this.feed.scrollHeight
      this.newMessages.hidden = true
      this.markRead()
    })
    this.element.addEventListener("pointerenter", () => {
      this.paused = true
    })
    this.element.addEventListener("pointerleave", () => {
      this.paused = false
    })
    // Clicking anywhere else on the page collapses the open conversation
    // without moving focus to the toggle (the click already put it elsewhere).
    document.addEventListener("pointerdown", (event) => {
      if (this.open && !this.element.contains(event.target as Node)) {
        this.setOpen(false, false)
      }
    })
    document.addEventListener("visibilitychange", () => this.markRead())
    window.addEventListener("resize", () => this.showRows())
    setInterval(() => {
      const now = Date.now()
      const elapsed = now - this.lastTick
      this.lastTick = now
      if (
        !this.open &&
        !this.paused &&
        !this.selectionActive &&
        !document.hidden &&
        !this.element.contains(document.activeElement)
      ) {
        for (const [id, remaining] of this.toasts) {
          if (remaining <= elapsed) this.toasts.delete(id)
          else this.toasts.set(id, remaining - elapsed)
        }
        this.showRows()
      }
      this.updateStatus()
    }, 500)
    this.updateStatus()
  }

  private key(suffix: string) {
    return `ah-conversation:${this.snapshot?.file}:${suffix}`
  }
  /** Grow the compose box to its text, up to its max-height. Only while it
   * shows: hidden, it has no scrollHeight. */
  private fitInput() {
    this.input.style.height = "auto"
    this.input.style.height = this.input.scrollHeight + "px"
  }
  private saveDraft() {
    if (!this.snapshot) return
    try {
      localStorage.setItem(this.key("draft"), this.input.value)
    } catch {
      /* unavailable */
    }
  }
  setConnected(value: boolean) {
    this.connected = value
    this.updateStatus()
  }
  suspendToasts(value: boolean) {
    this.selectionActive = value
    this.element.classList.toggle("selection-active", value)
  }
  reportError(message: string) {
    this.error.textContent = message
    this.error.hidden = !message
  }

  receive(snapshot: ThreadSnapshot, replay: boolean) {
    const first = this.snapshot === null
    const bottom = this.atBottom()
    this.snapshot = snapshot
    this.connected = true
    if (first) {
      try {
        const ids = JSON.parse(localStorage.getItem(this.key("read")) ?? "[]")
        if (Array.isArray(ids)) {
          this.read = new Set(ids.filter((id) => typeof id === "string"))
        }
        this.input.value = localStorage.getItem(this.key("draft")) ?? ""
      } catch {
        /* unavailable */
      }
    }
    let added = false
    // Your own new message takes the feed down to it, wherever it was, as in
    // a chat app
    let sent = false
    for (const entry of snapshot.entries) {
      if (entry.type === "activity" && !entry.text) continue
      if (!this.rows.has(entry.id)) {
        const row = this.renderMessage(entry)
        this.rows.set(entry.id, row)
        this.feed.append(row)
        added = true
        if (!replay && entry.type === "activity") this.toasts.set(entry.id, 8000)
        if (!replay && entry.type === "request") sent = true
      }
      if (entry.type === "request") {
        const state = snapshot.requests.find((state) => state.id === entry.id)
        const meta = this.rows.get(entry.id)!.querySelector(".conversation-meta")!
        const { label } = describe(entry, this.kinds)
        // The bubble says it's yours, so the meta line is only for the kind
        // of request and its state
        const stateText =
          state && state.status !== "done" ? state.status.replace("-", " ") : ""
        meta.textContent = [label, stateText].filter(Boolean).join(" · ")
        meta.toggleAttribute("hidden", !meta.textContent)
      }
    }
    this.showRows()
    if (this.open && added) {
      if (bottom || first || sent) {
        this.feed.scrollTop = this.feed.scrollHeight
        this.newMessages.hidden = true
      } else this.newMessages.hidden = false
    }
    this.empty.hidden = this.rows.size > 0 || !this.open
    this.markRead()
    this.updateStatus()
  }

  private renderMessage(entry: ThreadEntry) {
    const row = document.createElement("article")
    row.className = "conversation-message"
    row.dataset.id = entry.id
    row.dataset.from = entry.type === "activity" ? "agent" : "you"
    row.setAttribute("aria-label", entry.type === "activity" ? "Agent" : "You")
    const meta = document.createElement("div")
    meta.className = "conversation-meta"
    meta.textContent = entry.type === "activity" ? "Agent" : "You"
    row.append(meta)
    const selection = entry.type === "request" ? entry.args.selection : undefined
    if (entry.type === "request" && selection) {
      const quote = document.createElement("button")
      quote.type = "button"
      quote.className = "conversation-anchor"
      quote.textContent = selection.length > 180 ? selection.slice(0, 180) + "…" : selection
      quote.title = "Find this passage in the document"
      quote.addEventListener("click", () => this.findAnchor(entry))
      row.append(quote)
    }
    if (entry.type === "activity") {
      const parent = this.snapshot?.entries.find(
        (e) => e.type === "request" && entry.requests.includes(e.id),
      )
      if (parent?.type === "request" && parent.args.selection) {
        meta.textContent = `Agent · “${parent.args.selection.slice(0, 50)}”`
      }
    }
    const body = document.createElement("div")
    body.className = "conversation-body"
    body.innerHTML = markdown.render(
      entry.type === "request" ? describe(entry, this.kinds).body : (entry.text ?? ""),
    )
    for (const link of body.querySelectorAll("a")) {
      link.target = "_blank"
      link.rel = "noopener noreferrer"
    }
    row.append(body)
    if (entry.type === "activity") {
      const open = document.createElement("button")
      open.type = "button"
      open.className = "conversation-toast-open"
      open.setAttribute("aria-label", `Read agent message: ${entry.text?.slice(0, 100)}`)
      open.addEventListener("click", () => {
        this.setOpen(true)
        this.feed.scrollTop +=
          row.getBoundingClientRect().top - this.feed.getBoundingClientRect().top
        this.markRead()
      })
      const dismiss = document.createElement("button")
      dismiss.type = "button"
      dismiss.className = "conversation-dismiss"
      dismiss.textContent = "×"
      dismiss.setAttribute("aria-label", "Dismiss notification")
      dismiss.addEventListener("click", () => {
        this.toasts.delete(entry.id)
        this.showRows()
        this.toggle.focus()
      })
      row.append(open, dismiss)
    }
    return row
  }

  private findAnchor({ args }: Request) {
    const content = document.getElementById("content")!
    const needle = args.selection
    const nodes: Text[] = []
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map((node) => node.data).join("")
    let offset = text.indexOf(needle)
    if (offset >= 0 && text.indexOf(needle, offset + 1) >= 0) {
      while (offset >= 0) {
        if (
          (!args.prefix || text.slice(0, offset).endsWith(args.prefix)) &&
          (!args.suffix || text.slice(offset + needle.length).startsWith(args.suffix))
        )
          break
        offset = text.indexOf(needle, offset + 1)
      }
    }
    if (offset < 0) {
      this.reportError("This passage has changed and could not be located.")
      return
    }
    const range = document.createRange()
    let cursor = 0
    for (const node of nodes) {
      if (offset >= cursor && offset < cursor + node.length) {
        range.setStart(node, offset - cursor)
      }
      if (
        offset + needle.length > cursor &&
        offset + needle.length <= cursor + node.length
      ) {
        range.setEnd(node, offset + needle.length - cursor)
        break
      }
      cursor += node.length
    }
    this.setOpen(false)
    CSS.highlights.set("conversation-anchor", new Highlight(range))
    range.startContainer.parentElement?.scrollIntoView({ block: "center" })
    setTimeout(() => CSS.highlights.delete("conversation-anchor"), 2500)
  }

  private atBottom() {
    return this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 40
  }
  private showRows() {
    const visible = new Set([...this.toasts.keys()].slice(-3))
    for (const [id, row] of this.rows) row.hidden = !this.open && !visible.has(id)
    if (!this.open) {
      let available = window.innerHeight - 100
      for (const id of [...visible].reverse()) {
        const row = this.rows.get(id)
        if (!row) continue
        available -= row.offsetHeight + 8
        if (available < 0) row.hidden = true
      }
    }
  }
  /** Open, the compose box takes focus, since the toggle hides */
  private setOpen(value: boolean, refocus = true) {
    this.open = value
    if (value) this.onOpen()
    this.element.classList.toggle("open", value)
    this.form.hidden = !value
    this.newMessages.hidden = true
    this.empty.hidden = !value || this.rows.size > 0
    this.showRows()
    if (value) {
      // For a draft restored, or typed before it last closed
      this.fitInput()
      this.feed.scrollTop = this.feed.scrollHeight
      focusWhenRendered(this.input)
      this.markRead()
    } else {
      this.feed.scrollTop = 0
      if (refocus) (this.returnFocus?.isConnected ? this.returnFocus : this.toggle).focus()
      this.returnFocus = null
    }
    this.updateStatus()
  }
  private markRead() {
    if (!this.open || document.hidden || !this.snapshot) return
    // What shows of the feed: not under the dock
    const feed = this.feed.getBoundingClientRect()
    const bounds = { top: feed.top, bottom: feed.bottom - this.dock.offsetHeight }
    let changed = false
    for (const entry of this.snapshot.entries) {
      if (entry.type !== "activity" || !entry.text || this.read.has(entry.id)) continue
      const row = this.rows.get(entry.id)
      if (!row) continue
      const rect = row.getBoundingClientRect()
      if (
        Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) >=
        Math.min(32, rect.height)
      ) {
        this.read.add(entry.id)
        this.toasts.delete(entry.id)
        changed = true
      }
    }
    if (changed) {
      try {
        localStorage.setItem(this.key("read"), JSON.stringify([...this.read]))
      } catch {
        /* unavailable */
      }
      this.updateStatus()
    }
  }
  private updateStatus() {
    const states = this.snapshot?.requests ?? []
    const working = states.filter((state) => state.status === "working")
    const pending = states.filter((state) => state.status === "waiting").length
    const stale = working.some((state) => Date.now() - Date.parse(state.updatedAt) > 120000)
    let status = "ready",
      text = "Ready"
    if (!this.connected) {
      status = "disconnected"
      text = "Connecting…"
    } else if (!this.snapshot?.agentConnected) {
      status = "disconnected"
      text = "No agent connected"
    } else if (working.length && !stale) {
      status = "working"
      text = "Working…"
    } else if (stale || states.some((state) => state.status === "interrupted")) {
      status = "interrupted"
      text = "No recent update"
    } else if (states.some((state) => state.status === "needs-reply")) {
      status = "needs-reply"
      text = "Needs your reply"
    } else if (states.some((state) => state.status === "error")) {
      status = "error"
      text = "A request needs attention"
    } else if (pending) {
      status = "waiting"
      text = "Waiting for the agent"
    }
    if (pending) text += ` · ${pending} waiting`
    const unreadEntries =
      this.snapshot?.entries.filter(
        (entry) => entry.type === "activity" && entry.text && !this.read.has(entry.id),
      ) ?? []
    const unread = unreadEntries.length
    // Unread tints the toggle, for messages nothing shows: not one a toast
    // has up
    const unseen = unreadEntries.some(
      (entry) => this.open || this.rows.get(entry.id)?.hidden !== false,
    )
    this.element.dataset.status = status
    // Whether comments reach an agent: the toggle's dot when they do, and
    // beside the collapsed toggle, the pill saying why they don't
    this.element.dataset.agent = !this.connected
      ? "unknown"
      : this.snapshot?.agentConnected
        ? "connected"
        : "none"
    this.offline.textContent = text
    this.offline.hidden = this.open || status !== "disconnected"
    this.status.querySelector(".conversation-status-text")!.textContent = text
    this.status.hidden = !this.open || status === "ready"
    this.toggle.setAttribute("aria-expanded", String(this.open))
    const label = `${this.open ? "Collapse" : "Open"} conversation · ${text}${
      unread ? ` · ${unread} unread` : ""
    }`
    this.toggle.setAttribute("aria-label", label)
    this.toggle.title = `${label} (⌘I)`
    this.element.toggleAttribute("data-unread", unseen)
  }

  async send(input: RequestInput): Promise<RequestResult> {
    const response = await fetch(new URL("request", this.threadUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(await response.text())
    return await response.json()
  }
  private async submit() {
    const text = this.input.value.trim()
    if (!text || this.sending) return
    const question = this.snapshot?.requests.findLast(
      (state) => state.status === "needs-reply",
    )
    this.sending = true
    const button = this.form.querySelector<HTMLButtonElement>(".conversation-send")!
    button.disabled = true
    this.reportError("")
    try {
      await this.send({ kind: "chat", text, args: {}, replyTo: question?.id })
      if (this.input.value.trim() === text) this.input.value = ""
      this.fitInput()
      this.saveDraft()
      button.setAttribute("aria-label", "Send")
      button.removeAttribute("data-retry")
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : "Could not send message")
      button.setAttribute("aria-label", "Retry")
      button.toggleAttribute("data-retry", true)
    } finally {
      this.sending = false
      button.disabled = false
      this.input.focus()
    }
  }
}
