// The file page: an <ah-markdown> preview (styled by markdown.css) with the helix pane and the thread's
// comment popover (views/thread/) around it. Its URLs are relative to
// /view/markdown/<id>/, and the editor pane and the chat are each left out
// when turned off.

import { chatStylesheet, selectionPopover } from "../thread/page.ts"

// Both pages load only their own scripts and styles, and talk only to the
// server, over HTTP or its sockets; images and video can come from anywhere
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src *; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'none'; object-src 'none'">`

/** The ? dialog listing the page's keyboard shortcuts, for the parts it has */
function shortcutsDialog({ editor, chat }: { editor: boolean; chat: boolean }) {
  const rows: [string, string][] = [
    ["?", "Show this list"],
    ["⇧⌘C", "Copy the file's path"],
  ]
  if (editor) rows.push(["⌘E", "Show or hide the helix editor"])
  if (chat) {
    rows.push(
      ["⌘I", "Open or close the conversation"],
      ["Enter", "Send a message"],
      ["⇧Enter", "New line in a message"],
      ["Esc", "Close the conversation"],
      ["⌘Enter", "Send a selection comment"],
    )
  }
  const items = rows.map(
    ([keys, action]) => `<dt><kbd>${keys}</kbd></dt><dd>${action}</dd>`,
  )
  return `<dialog id="shortcuts" aria-labelledby="shortcuts-title" closedby="any">
  <h2 id="shortcuts-title">Keyboard shortcuts</h2>
  <dl>${items.join("")}</dl>
  ${chat ? '<p class="note">Select text in the document to comment on it</p>' : ""}
</dialog>`
}

/** `title` and `path` are escaped HTML */
export function page(
  title: string,
  { editor, chat, path }: { editor: boolean; chat: boolean; path: string },
) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}
<title>${title}</title>
<link rel="stylesheet" href="/github-markdown.css">
<link rel="stylesheet" href="../markdown.css">
<link rel="stylesheet" href="../xterm.css">
${chat ? chatStylesheet : ""}
<style>
  body { margin: 0; background-color: #ffffff; }
  @media (prefers-color-scheme: dark) { body { background-color: #0d1117; } }
  #layout { display: grid; grid-template-columns: 1fr; }
  body.editor-shown #layout { grid-template-columns: minmax(0, 45%) minmax(0, 1fr); }
  #editor-pane {
    display: none;
    position: sticky;
    top: 0;
    align-self: start;
    box-sizing: border-box;
    height: 100vh;
    overflow: hidden;
    padding: 6px 0 6px 6px;
    background: #020202; /* ayu_evolve background, so the pane's padding matches helix */
    border-right: 1px solid #d1d9e0;
  }
  body.editor-shown #editor-pane { display: block; }
  #editor-host { height: 100%; }
  /* Room for the conversation, which stays out of the editor pane */
  #preview-pane { padding-bottom: 80px; }
  body.editor-shown #conversation { width: min(380px, calc(55vw - 40px)); }
  body.editor-shown #conversation.open { width: min(560px, calc(55vw - 56px)); }
  #editor-host .xterm { height: 100%; }
  .markdown-body {
    box-sizing: border-box;
    min-width: 200px;
    max-width: 830px;
    margin: 0 auto;
    padding: 45px;
  }
  #editor-toggle {
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 11;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid #d1d9e0;
    border-radius: 6px;
    background: #f6f8fa;
    color: #59636e;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  #editor-toggle:hover { color: #1f2328; background: #eef1f4; }
  @media (prefers-color-scheme: dark) {
    #editor-pane { border-right-color: #3d444d; }
    #editor-toggle {
      background: #151b23;
      border-color: #3d444d;
      color: #9198a1;
      color-scheme: dark;
    }
    #editor-toggle:hover { color: #f0f6fc; background: #1c2330; }
  }
  #shortcuts {
    color-scheme: light dark;
    min-width: 320px;
    padding: 20px 24px;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-radius: 8px;
    background: light-dark(#ffffff, #151b23);
    color: light-dark(#1f2328, #e6edf3);
    box-shadow: 0 8px 28px #0004;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #shortcuts:focus { outline: none; }
  #shortcuts::backdrop { background: #0004; }
  #shortcuts h2 { margin: 0 0 12px; font-size: 15px; }
  #shortcuts dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 16px;
    align-items: baseline;
    margin: 0;
  }
  #shortcuts dt { text-align: right; }
  #shortcuts dd { margin: 0; }
  #shortcuts .note {
    margin: 16px 0 0;
    text-align: center;
    font-size: 13px;
    color: light-dark(#59636e, #9198a1);
  }
  /* Says what ⇧⌘C copied; chat's #toast isn't on every page */
  #copied {
    position: fixed;
    bottom: 24px;
    left: 50%;
    z-index: 12;
    transform: translate(-50%, 6px);
    padding: 8px 16px;
    border: 1px solid light-dark(transparent, #3d444d);
    border-radius: 8px;
    background: light-dark(#1f2328, #262c36);
    color: light-dark(#ffffff, #e6edf3);
    box-shadow: 0 8px 24px #0004;
    color-scheme: light dark;
    font: 13px -apple-system, BlinkMacSystemFont, sans-serif;
    opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
  }
  #copied.shown { opacity: 1; transform: translate(-50%, 0); }
  #shortcuts kbd {
    padding: 1px 6px;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: light-dark(#f6f8fa, #0d1117);
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
  }
</style>
</head>
<body data-path="${path}">
<div id="layout">
  ${editor ? '<div id="editor-pane"><div id="editor-host"></div></div>' : ""}
  <div id="preview-pane"><ah-markdown src="./"></ah-markdown></div>
</div>
${
  editor
    ? '<button id="editor-toggle" aria-label="Toggle helix editor" title="Toggle helix editor (⌘E)">✎</button>'
    : ""
}
${chat ? selectionPopover : ""}
${shortcutsDialog({ editor, chat })}
<div id="copied" role="status"></div>
<script type="module" src="../bundle.js"></script>
</body>
</html>`
}

/** Every open file side by side, each an <ah-markdown> from preview.js:
 * the element on a page other than the file page. Served at
 * /view/markdown/, so its URLs are relative to that. */
export function indexPage(files: { id: string; name: string }[]) {
  const columns = files.map(
    (d) =>
      `<section><h2><a href="${d.id}/">${d.name}</a></h2><ah-markdown src="${d.id}/"></ah-markdown></section>`,
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${csp}
<title>Open files</title>
<link rel="stylesheet" href="/github-markdown.css">
<link rel="stylesheet" href="markdown.css">
<style>
  body { margin: 0; background-color: #ffffff; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background-color: #0d1117; color: #9198a1; } }
  main { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(320px, 1fr); height: 100vh; }
  section { overflow-y: auto; border-right: 1px solid #3d444d; }
  h2 { margin: 0; padding: 8px 16px; font-size: 12px; }
  h2 a { color: inherit; }
  .markdown-body { padding: 8px 24px 24px; }
  .empty { padding: 24px; }
</style>
</head>
<body>
<main>${columns.join("") || '<p class="empty">No files open.</p>'}</main>
<script type="module" src="preview.js"></script>
</body>
</html>`
}
