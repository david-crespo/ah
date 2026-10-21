/// <reference lib="dom" />

// Browser half of the html backend, served as /view/html/chat.js and added to an
// HTML file's page by routes.ts. It reloads the page when the file or
// anything next to it changes, keeping the scroll position, and adds the
// thread: the conversation overlay and selection comments on the page's
// text. The script tag says where the thread is (data-ah-thread) and whether
// the chat is off (data-ah-chat="off").

import { Conversation } from "../thread/conversation.ts"
import { htmlKinds } from "./requests.ts"
import { setUpSelectionComments } from "../thread/selection.ts"

const script = document.querySelector<HTMLScriptElement>("script[data-ah-thread]")!
const threadUrl = new URL(script.dataset.ahThread!, location.href).href
const chat = script.dataset.ahChat !== "off"

// A reload should land where the user was reading
const scrollKey = `ah-html-scroll:${location.pathname}`
try {
  const saved = sessionStorage.getItem(scrollKey)
  if (saved) {
    sessionStorage.removeItem(scrollKey)
    const [x, y] = JSON.parse(saved)
    // After the page's own scripts have laid it out
    requestAnimationFrame(() => window.scrollTo(x, y))
  }
} catch {
  /* storage blocked: reload at the top */
}

function reload() {
  try {
    sessionStorage.setItem(scrollKey, JSON.stringify([window.scrollX, window.scrollY]))
  } catch {
    /* reload at the top */
  }
  location.reload()
}

let conversation: Conversation | null = null
if (chat) {
  let hidePopover = () => {}
  conversation = new Conversation(() => hidePopover(), htmlKinds, threadUrl)
  // A page's main content when it marks one, so the comment's surrounding
  // text comes from the page rather than its chrome
  const content = document.querySelector<HTMLElement>("main") ?? document.body
  hidePopover = setUpSelectionComments(content, conversation)
}

// One socket for reloads and the conversation. After a restart the server
// has forgotten the file until an agent opens it again, so keep retrying.
let closed = false
let opened = false
function connect() {
  const url = new URL("socket", threadUrl)
  url.protocol = "ws:"
  // Where this page is, for `ah view ls`: the dashboard's frames and
  // `ah view open` say in their URL
  const where = new URLSearchParams(location.search).get("in")
  if (where) url.searchParams.set("in", where)
  const ws = new WebSocket(url)
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === "thread") {
      conversation?.receive(msg, msg.replay)
      // For the page's own scripts, such as task_list.js, even with the chat off
      document.dispatchEvent(new CustomEvent("ah-thread", { detail: msg }))
    } else if (msg.type === "reload") reload()
    else if (msg.type === "closed") closed = true
  }
  ws.onopen = () => {
    // The file may have changed while the server was away
    if (opened) return reload()
    opened = true
  }
  ws.onclose = () => {
    conversation?.setConnected(false)
    if (!closed) setTimeout(connect, 1000)
  }
}
connect()
