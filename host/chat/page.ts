// What a page with a thread adds to its HTML: chat.css, served at /chat.css,
// and the selection comment popover with its toast, which selection.ts wires
// up. The conversation overlay (conversation.ts) builds its own markup.

export const chatStylesheet = '<link rel="stylesheet" href="/chat.css">'

export const selectionPopover = `<div id="popover">
  <textarea id="comment-text" placeholder="Comment for the agent…"></textarea>
  <div class="row">
    <button id="dellm" title="Rewrite the selection to sound like a person; comment text (if any) is extra guidance">de-LLM</button>
    <span class="hint">⌘⏎ to send · esc to cancel</span>
    <button id="send">Send</button>
  </div>
</div>
<div id="toast"></div>`
