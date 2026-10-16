/// <reference lib="dom" />

// A task list's items, served as /view/html/task_list.js; the page loads it
// and /task_list.css itself. The agent writes each item as
//
//   <ah-item id="4" status="done" rev="pstlrplp">
//     <h3>Title</h3>
//     <p>Detail…</p>
//   </ah-item>
//
// and the element lays it out: a status icon, the id, the title and the rev
// on one line, with the detail collapsed under it. An item done in several
// steps lists them in its detail, each with a status and rev of its own:
//
//   <ah-step status="done" rev="pqqsyksr">What the step does</ah-step>
//
// and its title line counts the ones done. Steps are lettered in order, so
// the second step of item 3 is 3B. Open and hold items get a
// Go button, which posts a `go` request with the item's id and title into the
// page's thread (views/html/requests.ts), and every item a comment button,
// which opens a box for an `item-comment` request. Each button shows its last request's state from the thread
// the page's socket carries (chat.js re-dispatches it as `ah-thread` on
// the document). The page reloads on every edit, so which items are open,
// and an unsent comment, are kept across reloads.

import type { ThreadSnapshot, RequestInput } from "../../subjects/thread/events.ts"

const STATUSES = ["todo", "doing", "done", "dropped", "hold"] as const
type Status = (typeof STATUSES)[number]

const svg = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`

const STATUS_ICONS: Record<Status, string> = {
  todo: svg(`<circle cx="8" cy="8" r="5.5"/>`),
  doing: svg(
    `<circle cx="8" cy="8" r="5.5"/><path class="fill" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/>`,
  ),
  done: svg(`<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.2 1.8 1.8 3.2-3.6"/>`),
  dropped: svg(`<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8 11.8 4.2"/>`),
  hold: svg(`<circle cx="8" cy="8" r="5.5"/><path d="M6.6 5.8v4.4M9.4 5.8v4.4"/>`),
}

/** A button's face for each state of its request; `ready` is the button's own */
const STATE_ICONS = {
  pending: svg(`<circle class="spin" cx="8" cy="8" r="5.5" pathLength="100"/>`),
  question: svg(
    `<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.1v.3"/><circle class="fill" cx="8" cy="11.1" r=".6"/>`,
  ),
  error: svg(
    `<path d="M8 2.8 13.6 12.5H2.4z"/><path d="M8 6.6v2.6"/><circle class="fill" cx="8" cy="10.9" r=".6"/>`,
  ),
}
type ButtonState = keyof typeof STATE_ICONS | "ready"

const GO_ICON = svg(
  `<path class="fill" d="M5.2 3.6a.7.7 0 0 1 1.06-.6l6.3 4.4a.7.7 0 0 1 0 1.15l-6.3 4.4a.7.7 0 0 1-1.06-.6z"/>`,
)
const COMMENT_ICON = svg(
  `<path d="M4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5L5 13v-2h-.5A1.5 1.5 0 0 1 3 9.5v-5A1.5 1.5 0 0 1 4.5 3z"/>`,
)

const STATE_TITLES: Record<Exclude<ButtonState, "ready">, string> = {
  pending: "Sent; the agent is on it",
  question: "The agent asked a question",
  error: "The agent reported an error",
}

// chat.js's script tag says where the page's thread is
const threadUrl = (() => {
  const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")
  return script?.dataset.ahThread ? new URL(script.dataset.ahThread, location.href) : null
})()

const openKey = `ah-tracker-open:${location.pathname}`
const openItems = new Set<string>(read(openKey) ?? [])
// The comment being written, if any: which item, and its text so far
const draftKey = `ah-tracker-draft:${location.pathname}`

let thread: ThreadSnapshot | null = null

/** A button that posts a request of its kind about an item into the thread,
 * showing the state of the last one */
class RequestButton {
  el = document.createElement("button")
  /** A post whose request the thread hasn't shown yet */
  #sending = false
  /** Why the last post couldn't be sent */
  #error: string | null = null

  readonly kind: string
  readonly item: () => string

  constructor(className: string, kind: string, item: () => string) {
    this.kind = kind
    this.item = item
    this.el.className = `ah-item-action ${className}`
    this.el.type = "button"
  }

  get state(): ButtonState {
    if (this.#error) return "error"
    const sent = thread?.entries.findLast(
      (e) => e.type === "request" && e.kind === this.kind && e.args.item === this.item(),
    )
    const request = sent && thread?.requests.find((r) => r.id === sent.id)
    switch (request?.status) {
      case "waiting":
      case "working":
        return "pending"
      case "needs-reply":
        return "question"
      case "error":
        return "error"
    }
    return this.#sending ? "pending" : "ready"
  }

  render(icon: string, title: string) {
    const state = this.state
    this.el.dataset.state = state
    this.el.innerHTML = state === "ready" ? icon : STATE_ICONS[state]
    const label =
      this.#error ??
      (state === "pending" && thread && !thread.agentConnected
        ? `Queued; no session is connected to take it`
        : state === "ready"
          ? title
          : STATE_TITLES[state])
    this.el.title = label
    this.el.setAttribute("aria-label", label)
  }

  /** Post a request, with the item's title as the page shows it; false if
   * it couldn't be sent */
  async post(
    text: string | undefined,
    title: string,
    rerender: () => void,
  ): Promise<boolean> {
    if (!threadUrl || this.#sending) return false
    this.#sending = true
    this.#error = null
    rerender()
    try {
      const request: RequestInput = {
        kind: this.kind,
        text,
        args: { item: this.item(), title },
      }
      const response = await fetch(new URL("request", threadUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error(await response.text())
    } catch (e) {
      this.#error = `Couldn't send: ${e instanceof Error ? e.message : e}`
    }
    this.#sending = false
    rerender()
    return !this.#error
  }
}

/** The page's one comment box, under the item it's for */
class CommentBox {
  el = document.createElement("div")
  #text = document.createElement("textarea")
  #item: AhItem | null = null

  constructor() {
    this.el.className = "ah-item-comment"
    this.el.hidden = true
    const row = document.createElement("div")
    row.className = "ah-item-comment-row"
    const hint = document.createElement("span")
    hint.textContent = "⌘⏎ to send · esc to close"
    const send = document.createElement("button")
    send.type = "button"
    send.textContent = "Send"
    send.addEventListener("click", () => void this.#send())
    row.append(hint, send)
    this.el.append(this.#text, row)
    this.#text.addEventListener("input", () => this.#saveDraft())
    this.#text.addEventListener("keydown", (e) => {
      // ctrl+enter for terminal-browser panes, where cmd chords may not arrive
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.#send()
      if (e.key === "Escape") this.close()
    })
    document.addEventListener("mousedown", (e) => {
      const target = e.target as Node
      if (
        this.#item &&
        !this.el.contains(target) &&
        !this.#item.commentButton.contains(target)
      )
        this.close()
    })
    window.addEventListener("resize", () => this.#place())
  }

  /** Open it under `item`, or close it if it's already there */
  toggle(item: AhItem, text = "") {
    if (this.#item === item) return this.close()
    if (!this.el.isConnected) document.body.append(this.el)
    this.#item = item
    this.#text.value = text
    this.#text.placeholder = `Comment on ${item.id}`
    this.el.hidden = false
    this.#place()
    this.#text.focus()
    this.#saveDraft()
  }

  close() {
    this.#item = null
    this.el.hidden = true
    this.#text.value = ""
    remove(draftKey)
  }

  #place() {
    if (!this.#item) return
    const anchor = this.#item.commentButton.getBoundingClientRect()
    const width = this.el.offsetWidth
    const maxLeft = document.documentElement.clientWidth - width - 8
    const left = Math.max(8, Math.min(anchor.right - width, maxLeft))
    this.el.style.left = `${window.scrollX + left}px`
    this.el.style.top = `${window.scrollY + anchor.bottom + 6}px`
  }

  #saveDraft() {
    if (this.#item) write(draftKey, [this.#item.id, this.#text.value])
  }

  async #send() {
    const item = this.#item
    const text = this.#text.value.trim()
    if (!item || !text) return
    if (await item.comment(text)) this.close()
  }
}

const commentBox = new CommentBox()

const statusOf = (el: HTMLElement): Status => {
  const s = el.getAttribute("status") ?? "todo"
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : "todo"
}

export class AhItem extends HTMLElement {
  static observedAttributes = ["status", "rev"]
  #built = false
  #icon = document.createElement("span")
  #progress = document.createElement("span")
  #rev = document.createElement("code")
  #go = new RequestButton("ah-item-go", "go", () => this.id)
  #comment = new RequestButton("ah-item-chat", "item-comment", () => this.id)
  #title = ""

  get status(): Status {
    return statusOf(this)
  }

  get commentButton(): HTMLElement {
    return this.#comment.el
  }

  connectedCallback() {
    if (this.#built) return
    this.#built = true
    const heading = [...this.children].find((c) => /^H[1-6]$/.test(c.tagName))
    this.#title = heading?.textContent?.trim().replace(/\s+/g, " ") ?? ""
    const rest = [...this.childNodes].filter(
      (n) => n !== heading && !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()),
    )

    const head = document.createElement(rest.length ? "summary" : "div")
    head.className = "ah-item-head"
    this.#icon.className = "ah-item-status"
    const id = document.createElement("span")
    id.className = "ah-item-id"
    id.textContent = this.id
    const title = heading ?? document.createElement("span")
    title.classList.add("ah-item-title")
    this.#rev.className = "ah-item-rev"
    // Inside a <summary>, a click would also toggle the detail
    const onClick = (button: HTMLElement, action: () => void) =>
      button.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        action()
      })
    onClick(
      this.#go.el,
      () => void this.#go.post(undefined, this.#title, () => this.#render()),
    )
    onClick(this.#comment.el, () => commentBox.toggle(this))
    head.append(this.#icon, id, title)
    if (rest.length) {
      const chevron = document.createElement("span")
      chevron.className = "ah-item-chevron"
      chevron.innerHTML = svg(`<path d="m6 4.5 3.5 3.5L6 11.5"/>`)
      head.append(chevron)
    }
    // The page reloads on every edit, so the steps are counted once
    const steps = [...this.querySelectorAll<HTMLElement>("ah-step")]
      .map(statusOf)
      .filter((s) => s !== "dropped")
    this.#progress.className = "ah-item-progress"
    this.#progress.hidden = !steps.length
    this.#progress.textContent = `${steps.filter((s) => s === "done").length}/${steps.length}`
    head.append(this.#progress, this.#rev, this.#comment.el, this.#go.el)

    if (rest.length) {
      const details = document.createElement("details")
      const body = document.createElement("div")
      body.className = "ah-item-body"
      body.append(...rest)
      details.append(head, body)
      details.open = openItems.has(this.id)
      details.addEventListener("toggle", () => {
        if (details.open) openItems.add(this.id)
        else openItems.delete(this.id)
        write(openKey, [...openItems])
      })
      this.replaceChildren(details)
    } else {
      this.replaceChildren(head)
    }
    this.#render()

    // A comment that was being written when the page reloaded
    const [draftId, draft] = read(draftKey) ?? []
    if (threadUrl && draftId === this.id) {
      requestAnimationFrame(() => commentBox.toggle(this, draft ?? ""))
    }
  }

  attributeChangedCallback() {
    if (this.#built) this.#render()
  }

  /** Update the buttons from the thread */
  update() {
    if (this.#built) this.#render()
  }

  /** Post a comment on this item; false if it couldn't be sent */
  comment(text: string): Promise<boolean> {
    return this.#comment.post(text, this.#title, () => this.#render())
  }

  #render() {
    const status = this.status
    this.#icon.innerHTML = STATUS_ICONS[status]
    this.#icon.title = status
    const rev = this.getAttribute("rev")
    this.#rev.textContent = rev ?? ""
    this.#rev.hidden = !rev
    this.#go.el.hidden = !threadUrl || !(status === "todo" || status === "hold")
    this.#go.render(GO_ICON, `Go ahead: ${this.id}`)
    this.#go.el.disabled = this.#go.state === "pending"
    this.#comment.el.hidden = !threadUrl
    this.#comment.render(COMMENT_ICON, `Comment on ${this.id}`)
  }
}

document.addEventListener("ah-thread", (e) => {
  thread = (e as CustomEvent<ThreadSnapshot>).detail
  for (const item of document.querySelectorAll<AhItem>("ah-item")) item.update()
})

customElements.define("ah-item", AhItem)

/** One step of an item: a status icon, its letter, what it does, and its rev */
export class AhStep extends HTMLElement {
  static observedAttributes = ["status", "rev"]
  #built = false
  #icon = document.createElement("span")
  #rev = document.createElement("code")

  connectedCallback() {
    if (this.#built) return
    this.#built = true
    const text = document.createElement("span")
    text.className = "ah-step-text"
    text.append(...this.childNodes)
    // Dropped steps keep their letter, so the later ones don't shift
    const letter = document.createElement("span")
    letter.className = "ah-step-letter"
    const index = [...(this.closest("ah-item")?.querySelectorAll("ah-step") ?? [])].indexOf(
      this,
    )
    letter.textContent = String.fromCharCode(65 + Math.max(index, 0))
    this.#icon.className = "ah-step-status"
    this.#rev.className = "ah-item-rev"
    this.replaceChildren(this.#icon, letter, text, this.#rev)
    this.#render()
  }

  attributeChangedCallback() {
    if (this.#built) this.#render()
  }

  #render() {
    const status = statusOf(this)
    this.#icon.innerHTML = STATUS_ICONS[status]
    this.#icon.title = status
    const rev = this.getAttribute("rev")
    this.#rev.textContent = rev ?? ""
    this.#rev.hidden = !rev
  }
}

customElements.define("ah-step", AhStep)

/** Park and Done buttons by the title, or Resume once it's parked or done,
 * which have the server set the tracker's status and take it out of the
 * tracker role. The agent isn't asked: the page reloads with the change.
 * Only on a task list in the tracker role, which the server marks with an
 * `ah-status` meta. */
function statusButtons() {
  const title = document.querySelector("main > h1")
  const status = document.querySelector<HTMLMetaElement>('meta[name="ah-status"]')?.content
  if (!threadUrl || !title || !status) return
  const box = document.createElement("span")
  box.className = "ah-tracker-status"
  const button = (label: string, to: string, tip: string) => {
    const b = document.createElement("button")
    b.textContent = label
    b.title = tip
    b.onclick = async () => {
      for (const x of box.querySelectorAll("button")) x.disabled = true
      const res = await fetch(new URL("tracker-status", threadUrl), {
        method: "POST",
        body: JSON.stringify({ status: to }),
      })
      if (res.ok) return
      for (const x of box.querySelectorAll("button")) x.disabled = false
      console.error("ah: couldn't set the tracker's status:", res.status, await res.text())
    }
    return b
  }
  if (status === "active") {
    box.append(
      button("Park", "parked", "Work is left, but take it out of the list until resumed"),
      button("Done", "done", "No work is left: take it out of the list"),
    )
  } else {
    const label = document.createElement("span")
    label.textContent = status === "done" ? "Done" : "Parked"
    box.append(label, button("Resume", "active", "Put it back in the list"))
  }
  title.append(box)
}
statusButtons()

function read(key: string): string[] | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null")
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function write(key: string, value: string[]) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked: items start closed after a reload */
  }
}

function remove(key: string) {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* storage blocked */
  }
}
