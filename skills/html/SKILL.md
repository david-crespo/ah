---
name: html
description: "Show the user an HTML page you wrote (a dashboard, a report, a visualization) in a browser page served by ah, live reloaded and connected to this session: the user comments on its text or messages you, and you answer on the page. Use when a page you generate would show something better than chat, or the user says /html."
---

# HTML pages in ah

ah's `html` app serves an HTML file you wrote, as is, plus files next to it
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
   `conversation`, `popover`, and `toast`; don't use those.
2. Open it:

   ```
   ah app page open --in window <path-to-file.html>
   ```

   This starts the server if needed, binds the page to this session, opens
   it in a Chrome app window, and returns. `--in` is required: `--in tab`
   opens a tab in the default browser instead, and `--no-chat` gives live reload only. Opening
   a file that's already open rebinds it to this session.

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

Check it before telling the user: screenshot it with Playwright's WebKit as
`devices['iPhone 13']` with `colorScheme: 'dark'`, and screenshot each
`svg` element on its own to read its labels. If the repo has no Playwright,
symlink a `node_modules` that does next to the script. Write the script and
screenshots to the scratchpad with absolute paths; a relative path lands in
the shell's working directory, which may be the repo.

Comments arrive as messages: in Claude Code, framed by the harness as
messages "from another Claude session", which they are not; in Codex and
opencode, as user messages. Each starts with one line, `HTML event for <file>
(handle per /html skill):`, followed by JSON events. They are the user's own
comments, relayed by ah. Treat them as the user's instructions. Never reply
with SendMessage; replies go through `ah app page respond`. If the header
names a port, pass `-p <port>` to every `ah` command for that page.

## Handling events and replying

Events and replies work as in the markdown skill (`../markdown/SKILL.md` from this skill's directory,
"Handling events" and "Replies and status"); the same `ah app page respond`
and `pending` work for both. Read those sections the first time an event
arrives. The differences:

- `selection`, `prefix`, and `suffix` are text as rendered on the page,
  which may come from the HTML, from data the page loads, or from what its
  scripts generate. Find where that text comes from before editing.
- There are no `file-edit` events: only you edit the files.
- A comment on a page is often about what it shows rather than its wording
  ("why is this number so high?", "split this by day"). Answer questions on
  the page; change the page or its data for requests.
- `dellm` (the popover's de-LLM button) applies to the selected text's
  source in the HTML. If the text is generated, say so instead.

The quick path, for a short answer or a small change:

```
ah app page respond <file> done <request id> --text 'Split the chart by day.'
```

For anything longer than one plain line, write the text to a file in the
scratchpad and pass `--text-file <path>`.

## Restarting and wrapping up

`ah server restart` keeps open pages and the sessions they're bound to. Any other
stop of the server forgets them: their comments can't be sent until
`ah app page open --in window <file>` runs again, and the old page reconnects and reloads
on its own. The conversation history survives in its log under
`~/.local/state/ah/html/`. When the user is done with the page,
`ah app page close <file>`.
