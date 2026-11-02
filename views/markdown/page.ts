// The file page: an <ah-markdown> preview (styled by markdown.css) with the editor pane and the thread's
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
    ["⌘F", "Find in the document"],
    ["⌘G", "Next match (⇧⌘G previous)"],
    ["⇧⌘C", "Copy the file's path"],
    ["⌘D", "Show or hide the changes since a revision"],
    ["B", "Pick the revision to show changes since"],
    ["] / [", "Next or previous change"],
  ]
  if (editor) {
    rows.push(
      ["⌘E", "Show or hide the editor"],
      ["⌘-click", "Show that spot in the editor"],
    )
  }
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
  /* Hidden, the pane keeps its shown size out of the layout, so the editor
     can start at that size before it's first shown (terminal_pane.ts) */
  body:not(.editor-shown) #editor-pane {
    position: fixed;
    left: 0;
    width: 45%;
    visibility: hidden;
  }
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
  /* Its top and height center it in the diff bar, when that's shown */
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
  /* The diff mode's base and change count, above the preview */
  #diff-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    gap: 12px;
    align-items: center;
    /* Across the pane, its contents in line with the text (markdown.css's
       830px column with 45px padding) */
    padding: 0 max(45px, calc((100% - 740px) / 2));
    /* Tall enough that the editor toggle, fixed 10px from the top and 28px
       tall, sits centered in it */
    height: 49px;
    box-sizing: border-box;
    background: light-dark(#ffffff, #0d1117);
    border-bottom: 1px solid light-dark(#d1d9e0, #3d444d);
    color: light-dark(#59636e, #9198a1);
    color-scheme: light dark;
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #diff-bar[hidden] { display: none; }
  /* Clear of the bar when a change is scrolled to */
  .diff-added, .diff-removed, .diff-old, .diff-new { scroll-margin-top: 60px; }
  #diff-relation, #diff-info { flex: none; white-space: nowrap; }
  /* Shrinks first, eliding the base's name */
  #diff-base {
    display: flex;
    align-items: center;
    min-width: 0;
    max-width: 44ch;
    padding: 2px 8px;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-radius: 4px;
    background: light-dark(#f6f8fa, #151b23);
    color: light-dark(#1f2328, #e6edf3);
    font: inherit;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }
  #diff-base-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #diff-base::after {
    flex: none;
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 2px 3px 10px;
    border: solid light-dark(#59636e, #9198a1);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  #base-picker {
    position: fixed;
    inset: auto;
    width: min(560px, calc(100vw - 32px));
    max-height: min(420px, 70vh);
    margin: 0;
    padding: 0;
    overflow: hidden;
    flex-direction: column;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-radius: 8px;
    background: light-dark(#ffffff, #151b23);
    color: light-dark(#1f2328, #e6edf3);
    box-shadow: 0 8px 28px #0003;
    color-scheme: light dark;
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #base-picker:popover-open { display: flex; }
  #base-picker input {
    margin: 8px;
    padding: 6px 8px;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #base-picker ul { margin: 0; padding: 0 0 6px; overflow-y: auto; list-style: none; }
  #base-picker li {
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 12px;
    padding: 6px 12px;
  }
  #base-picker .stat {
    grid-area: 1 / 2 / 3 / 3;
    align-self: center;
    font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #base-picker .stat ins { color: light-dark(#1a7f37, #3fb950); text-decoration: none; }
  #base-picker .stat del { color: light-dark(#cf222e, #f85149); text-decoration: none; }
  #base-picker .bookmark {
    padding: 0 5px;
    border-radius: 9px;
    background: light-dark(#ddf4ff, #388bfd33);
    color: light-dark(#0969da, #79c0ff);
    font-size: 11px;
  }
  #base-picker li.note { color: light-dark(#59636e, #9198a1); }
  #base-picker [role="option"] { cursor: pointer; }
  #base-picker [role="option"]:hover,
  #base-picker [aria-selected="true"] { background: light-dark(#ddf4ff, #388bfd26); }
  #base-picker .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #base-picker .detail {
    color: light-dark(#59636e, #9198a1);
    font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #diff-info.error { color: light-dark(#cf222e, #f85149); }
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
  /* ⌘F's find bar (find.ts), as tall as the conversation's toggle */
  #find {
    position: fixed;
    bottom: 20px;
    left: 20px;
    z-index: 11;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    height: 36px;
    padding: 0 10px 0 0;
    border: 1px solid light-dark(#d1d9e0, #3d444d);
    border-radius: 6px;
    background: light-dark(#ffffff, #151b23);
    box-shadow: 0 4px 16px #0003;
    color: light-dark(#59636e, #9198a1);
    color-scheme: light dark;
    font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
  }
  #find[hidden] { display: none; }
  /* Bottom left of the preview, across from the conversation's toggle */
  body.editor-shown #find { left: calc(45% + 20px); }
  #find input {
    width: 200px;
    padding: 0 8px;
    border: 0;
    outline: none;
    background: transparent;
    color: light-dark(#1f2328, #e6edf3);
    font: 14px -apple-system, BlinkMacSystemFont, sans-serif;
  }
  #find-count { min-width: 3em; text-align: right; font-variant-numeric: tabular-nums; }
  /* Its marks sit over the text, see-through so the text shows. (Blending
     them with the text instead fails in WebKit once the helix pane's canvas
     is on the page.) */
  #find-marks { position: absolute; top: 0; left: 0; z-index: 1; pointer-events: none; }
  #find-marks > div {
    position: absolute;
    border-radius: 2px;
    background: rgba(255, 230, 0, 0.5);
  }
  /* The current match in the page's link blue, ringed, so it stands apart
     from the yellow of the rest */
  #find-marks > .current {
    background: rgba(9, 105, 218, 0.3);
    box-shadow: 0 0 0 2px #0969da;
  }
  @media (prefers-color-scheme: dark) {
    #find-marks > div { background: rgba(255, 225, 0, 0.42); }
    #find-marks > .current {
      background: rgba(88, 166, 255, 0.4);
      box-shadow: 0 0 0 2px #58a6ff;
    }
  }
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
  <div id="preview-pane">
    <div id="diff-bar" hidden>
      <span id="diff-relation">Changes since</span>
      <button id="diff-base" popovertarget="base-picker" title="Pick another base (B)"><span id="diff-base-label"></span></button>
      <span id="diff-info" role="status"></span>
      <div id="base-picker" popover>
        <input aria-label="Revision to diff from" placeholder="Any revset, like main or @--" autocomplete="off" spellcheck="false">
        <ul role="listbox" aria-label="Bases"></ul>
      </div>
    </div>
    <ah-markdown src="./"></ah-markdown>
  </div>
</div>
${
  editor
    ? '<button id="editor-toggle" aria-label="Toggle editor" title="Toggle editor (⌘E)">✎</button>'
    : ""
}
${chat ? selectionPopover : ""}
<div id="find-marks"></div>
<div id="find" role="search" hidden>
  <input aria-label="Find in the document" placeholder="Find" autocomplete="off" spellcheck="false">
  <span id="find-count" role="status"></span>
</div>
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
