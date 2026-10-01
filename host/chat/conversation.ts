/// <reference lib="dom" />
import MarkdownExit from "markdown-exit"
import type {
  CommentResult,
  Event as ThreadEvent,
  FeedSnapshot,
  UserInput,
} from "./events.ts"

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
  private badge: HTMLElement
  private snapshot: FeedSnapshot | null = null
  private rows = new Map<string, HTMLElement>()
  private read = new Set<string>()
  private toasts = new Map<string, number>()
  private connected = false
  private open = false
  private paused = false
  private selectionActive = false
  private sending = false
  private lastTick = Date.now()

  private onOpen: () => void
  private threadUrl: string

  /** `threadUrl` is where the thread's routes are (host/chat/routes.ts);
   * by default, relative to the page */
  constructor(onOpen: () => void, threadUrl = location.href) {
    this.onOpen = onOpen
    this.threadUrl = threadUrl
    this.element.id = "conversation"
    this.element.setAttribute("aria-label", "Conversation")
    this.element.innerHTML = `
      <div class="conversation-feed" id="conversation-history" role="region" aria-label="Conversation history"></div>
      <p class="conversation-empty" hidden>Ask a question or leave a comment on the document.</p>
      <button class="conversation-new" type="button" hidden>New messages ↓</button>
      <p class="conversation-error" role="alert" hidden></p>
      <div class="conversation-status" role="status"><span class="conversation-status-spinner" aria-hidden="true"></span><span class="conversation-status-text"></span></div>
      <div class="conversation-controls">
        <form class="conversation-compose" hidden>
          <textarea rows="1" aria-label="Message the agent" placeholder="Message the agent…"></textarea>
          <button class="conversation-send" type="submit">Send</button>
        </form>
        <button class="conversation-toggle" type="button" aria-expanded="false" aria-controls="conversation-history" aria-label="Open conversation">
          <span class="conversation-spinner" aria-hidden="true"></span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>
          <span class="conversation-unread" hidden></span>
        </button>
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
    this.badge = this.element.querySelector(".conversation-unread")!
    this.toggle.addEventListener("click", () => this.setOpen(!this.open, true))
    this.form.addEventListener("submit", (event) => {
      event.preventDefault()
      void this.submit()
    })
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto"
      this.input.style.height = Math.min(110, this.input.scrollHeight) + "px"
      this.saveDraft()
    })
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.open) {
        event.preventDefault()
        this.setOpen(false)
      }
      if (
        event.target === this.input &&
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        void this.submit()
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
        this.setOpen(false, false, false)
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

  receive(snapshot: FeedSnapshot, replay: boolean) {
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
    for (const event of snapshot.events) {
      if (event.kind === "activity" && !event.text) continue
      if (!this.rows.has(event.id)) {
        const row = this.renderMessage(event)
        this.rows.set(event.id, row)
        this.feed.append(row)
        added = true
        if (!replay && event.kind === "activity") this.toasts.set(event.id, 8000)
      }
      if (event.kind !== "activity") {
        const state = snapshot.requests.find((state) => state.id === event.id)
        const label = this.rows.get(event.id)!.querySelector(".conversation-meta")!
        const stateText =
          state && state.status !== "done" ? ` · ${state.status.replace("-", " ")}` : ""
        label.textContent = `You${
          event.kind === "message" ? "" : " · Selection comment"
        }${stateText}`
      }
    }
    this.showRows()
    if (this.open && added) {
      if (bottom || first) this.feed.scrollTop = this.feed.scrollHeight
      else this.newMessages.hidden = false
    }
    this.empty.hidden = this.rows.size > 0 || !this.open
    this.markRead()
    this.updateStatus()
  }

  private renderMessage(event: ThreadEvent) {
    const row = document.createElement("article")
    row.className = "conversation-message"
    row.dataset.id = event.id
    row.dataset.from = event.kind === "activity" ? "agent" : "you"
    const meta = document.createElement("div")
    meta.className = "conversation-meta"
    meta.textContent = event.kind === "activity" ? "Agent" : "You"
    row.append(meta)
    if (event.kind !== "activity" && event.selection) {
      const quote = document.createElement("button")
      quote.type = "button"
      quote.className = "conversation-anchor"
      quote.textContent =
        event.selection.length > 180 ? event.selection.slice(0, 180) + "…" : event.selection
      quote.title = "Find this passage in the document"
      quote.addEventListener("click", () => this.findAnchor(event))
      row.append(quote)
    }
    if (event.kind === "activity") {
      const parent = this.snapshot?.events.find((entry) =>
        event.requestIds.includes(entry.id),
      )
      if (parent && "selection" in parent && parent.selection) {
        meta.textContent = `Agent · “${parent.selection.slice(0, 50)}”`
      }
    }
    const body = document.createElement("div")
    body.className = "conversation-body"
    const text = "text" in event ? event.text : undefined
    body.innerHTML = markdown.render(
      text ||
        (event.kind === "dellm" ? "Rewrite this passage to sound like a person." : ""),
    )
    for (const link of body.querySelectorAll("a")) {
      link.target = "_blank"
      link.rel = "noopener noreferrer"
    }
    row.append(body)
    if (event.kind === "activity") {
      const open = document.createElement("button")
      open.type = "button"
      open.className = "conversation-toast-open"
      open.setAttribute("aria-label", `Read agent message: ${event.text?.slice(0, 100)}`)
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
        this.toasts.delete(event.id)
        this.showRows()
        this.toggle.focus()
      })
      row.append(open, dismiss)
    }
    return row
  }

  private findAnchor(event: UserInput) {
    const content = document.getElementById("content")!
    const needle = event.selection!
    const nodes: Text[] = []
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map((node) => node.data).join("")
    let offset = text.indexOf(needle)
    if (offset >= 0 && text.indexOf(needle, offset + 1) >= 0) {
      while (offset >= 0) {
        if (
          (!event.prefix || text.slice(0, offset).endsWith(event.prefix)) &&
          (!event.suffix || text.slice(offset + needle.length).startsWith(event.suffix))
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
  private setOpen(value: boolean, focus = false, refocus = true) {
    this.open = value
    if (value) this.onOpen()
    this.element.classList.toggle("open", value)
    this.form.hidden = !value
    this.newMessages.hidden = true
    this.empty.hidden = !value || this.rows.size > 0
    this.showRows()
    if (value) {
      this.feed.scrollTop = this.feed.scrollHeight
      if (focus) focusWhenRendered(this.input)
      else this.toggle.focus()
      this.markRead()
    } else {
      this.feed.scrollTop = 0
      if (refocus) this.toggle.focus()
    }
    this.updateStatus()
  }
  private markRead() {
    if (!this.open || document.hidden || !this.snapshot) return
    const bounds = this.feed.getBoundingClientRect()
    let changed = false
    for (const event of this.snapshot.events) {
      if (event.kind !== "activity" || !event.text || this.read.has(event.id)) continue
      const row = this.rows.get(event.id)
      if (!row) continue
      const rect = row.getBoundingClientRect()
      if (
        Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) >=
        Math.min(32, rect.height)
      ) {
        this.read.add(event.id)
        this.toasts.delete(event.id)
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
    const unread =
      this.snapshot?.events.filter(
        (event) => event.kind === "activity" && event.text && !this.read.has(event.id),
      ).length ?? 0
    this.element.dataset.status = status
    this.status.querySelector(".conversation-status-text")!.textContent = text
    this.status.hidden = !this.open || status === "ready"
    this.toggle.setAttribute("aria-expanded", String(this.open))
    const label = `${this.open ? "Collapse" : "Open"} conversation · ${text}${
      unread ? ` · ${unread} unread` : ""
    }`
    this.toggle.setAttribute("aria-label", label)
    this.toggle.title = label
    this.badge.hidden = !unread && !["needs-reply", "error"].includes(status)
  }

  async send(input: UserInput): Promise<CommentResult> {
    const response = await fetch(new URL("comment", this.threadUrl), {
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
    const button = this.form.querySelector("button")!
    button.disabled = true
    this.reportError("")
    try {
      await this.send({ kind: "message", text, replyTo: question?.id })
      if (this.input.value.trim() === text) this.input.value = ""
      this.input.style.height = "auto"
      this.saveDraft()
      button.textContent = "Send"
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : "Could not send message")
      button.textContent = "Retry"
    } finally {
      this.sending = false
      button.disabled = false
      this.input.focus()
    }
  }
}
