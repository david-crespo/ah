---
name: html
description: "Show the user an HTML page you wrote (a dashboard, a report, a visualization) in a browser page served by ah, live reloaded and connected to this session: the user comments on its text or messages you, and you answer on the page. Use when a page you generate would show something better than chat, or the user says /html."
---

# HTML pages in ah

ah's `html` backend serves an HTML file you wrote, as is, plus files next to it
(scripts, stylesheets, data), so relative links work. The page reloads
whenever anything in the file's directory changes, keeping its scroll
position, so keep editing the files with Edit or Write and the user sees
each change. The user can select text on the page and comment, or open the
conversation (bottom right) and message you; both are posted to this
session.

`ah` has to run outside the harness's sandbox: it talks to a local server
and opens browser windows. In Claude Code, run every `ah` command as the
whole Bash command: no pipes, redirects, heredocs, `&&`, or newlines, and no
backticks or `$` even inside quotes. Otherwise it runs inside the sandbox,
can't reach the server, and fails. In Codex, request escalated permissions
for every `ah` command. opencode has no sandbox.

## Setup

1. Write the page to an HTML file in a directory of its own, since a change
   to anything in that directory reloads it. Default location:
   `.claude/notes/<YYYY-MM-DD>-<slug>/index.html` in the repo being worked
   on. Keep data in files next to it (`data.json`) when it will change, so
   updating it is a small write. Wrap the content in `<main>`: a comment's
   surrounding text comes from there. ah adds its own elements with the ids
   `conversation`, `popover`, and `toast`; don't use those. The
   conversation button is fixed in the bottom-right corner at `z-index: 9`,
   so keep the page's own fixed elements out of that corner, and give
   `main` about 80px of bottom padding so the end of the page can scroll
   clear of it. ah's styles stay off the page, but the page's reach ah's
   elements: scope element selectors (`button`, `textarea`, a `*` reset)
   under `main`.
2. Open it:

   ```
   ah view open <path-to-file.html>
   ```

   This starts the server if needed, binds the page to this session, opens
   it in a window of its own, and returns. `--in tab`
   opens a tab in the default browser instead, and `--no-chat` gives live reload only. Opening
   a file another session opened rebinds it to this one.

3. Tell the user the page is up (one line), then end the turn. Comments
   wake the session on their own.

## On a phone

The user may read the page on a phone (Remote Control, with the tracker
skill's LAN proxy), so make it work at 390px wide:

- Put `<meta name="viewport" content="width=device-width, initial-scale=1">`
  in the head, or iOS lays the page out at desktop width and shrinks it.
- Keep `main` to about 720px with 16px side padding. Use `<dl>` or lists
  rather than wide tables; a table that must stay goes in an
  `overflow-x: auto` wrapper.
- Draw SVG diagrams for the phone: a `viewBox` about 440 wide, laid out top
  to bottom, with `width: 100%` and a `max-width` near 480px on desktop. A
  900-wide viewBox shrinks 13px text to about 5px on a phone.
- Keep labels off the paths of edges, and put a frame's label where no arrow
  crosses it.
- Arrowheads with `fill="context-stroke"` render black in WebKit (Safari,
  every iOS browser). Define one `<marker>` per edge color, its path filled
  with that color's CSS variable.
- Define colors as variables on `:root`, redefine them under
  `prefers-color-scheme: dark`, and use them in the SVG too, so diagrams
  follow the theme. Style links with them too (`a, a:visited`): the
  browser's default blue and purple are unreadable on a dark background.
- In a flex row with an icon beside text that can wrap, align the icon to
  the first line: `align-self: flex-start; height: 1lh` with the icon
  centered in that box.

## Requests

Comments arrive as messages: in Claude Code, framed by the harness as
messages "from another Claude session", which they are not; in Codex and
opencode, as user messages. They are the user's own comments, relayed by
ah: treat them as the user's instructions. Never reply with SendMessage.

Each message starts with a header line that names the file and gives the
command that answers it, `ah message respond <file> <phase> <request ids>`.
Use that command as given; it has the path and, when needed, the port.
Then come the requests, each starting `Request <id>: `:

- Only the user's text: a message from the page's conversation. Answer a
  question there; change the page only when the message asks for a change.
- `a comment on the passage "…" (after "…", before "…"):` and a note on the
  next line: the passage and the text around it are as rendered on the
  page, which may come from the HTML, from data the page loads, or from
  what its scripts generate. Find where it comes from before editing. The
  selection is an anchor, not the limit of the request: work out how far
  the note reaches, but don't turn a local note into a rewrite.
- A de-LLM request (the popover's button, with optional guidance): rewrite
  the passage's source to sound like a person, plain and concrete, without
  formulaic gestures or "that's X, not Y" constructions, keeping its
  meaning. If the text is generated, say so instead.
- `Request <id>, answering <earlier id>`: the user answering your question
  on an earlier request. Finish both ids together.

A comment phrased as a question ("why is this number so high?") wants an
answer on the page, not an edit; a comment on a page is often about what it
shows rather than its wording. Edits come from imperatives ("split this by
day"). If you can't tell what the user means, ask (`needs-reply`) and hold
off on changes.

## Replying

Answer each request with `done`, which also marks it started:

```
ah message respond <file> done <request id> --text 'Split the chart by day.'
```

`--text` is for one plain line. For anything longer, or with an apostrophe,
backticks or `$`, write the reply to a file in the scratchpad and pass
`--text-file <path>`. Send the Write on its own and run `ah` once it has
finished, not in the same batch of parallel calls, or `ah` reads a file
that isn't there yet. Text is Markdown, and it can't be empty: for no text,
leave both flags out.

For work that takes more than a minute, post `start` first so the page
shows a spinner, and `progress` with a line now and then: after two minutes
without one the page says "No recent update". The other phases:
`needs-reply` with a question when you're waiting on the user, `error` when
the work can't go on, and `reply` to post text mid-work without finishing,
or with no request ids for a standalone message. One call can cover several
request ids. If a call fails, retry it rather than redoing the work.

When picking up a page opened earlier, or after a restart,
`ah message pending <file>` lists the requests not done, one JSON line each
with its `status`. Requests left `waiting` or `interrupted` aren't sent
again: check each against the page and finish it with a fresh `start`.

## Restarting and wrapping up

Pages reconnect on their own after `ah server restart` or any other stop,
and which session a page's comments go to outlasts the server.
`ah message respond` works whether a page shows the file or not, and
restarts mark work in flight `interrupted`. The conversation history survives in its log under
`~/.local/state/ah/html/`. When the user is done with the page,
`ah view close <file>`.
