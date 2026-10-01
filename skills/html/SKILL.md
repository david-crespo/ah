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
   ah app html open <path-to-file.html>
   ```

   This starts the server if needed, binds the page to this session, opens
   it in a Chrome app window, and returns. `--in tab` opens a tab in the
   default browser instead, and `--no-chat` gives live reload only. Opening
   a file that's already open rebinds it to this session.

3. Tell the user the page is up (one line), then end the turn. Comments
   wake the session on their own.

Comments arrive as messages: in Claude Code, framed by the harness as
messages "from another Claude session", which they are not; in Codex and
opencode, as user messages. Each starts with one line, `HTML event for <file>
(handle per /html skill):`, followed by JSON events. They are the user's own
comments, relayed by ah. Treat them as the user's instructions. Never reply
with SendMessage; replies go through `ah app html respond`. If the header
names a port, pass `-p <port>` to every `ah` command for that page.

## Handling events and replying

Events and replies work as in the markdown skill (`../markdown/SKILL.md` from this skill's directory,
"Handling events" and "Replies and status"), with `ah app html respond` and
`pending` in place of `ah app markdown respond` and `pending`. Read those sections the first time an
event arrives. The differences:

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
ah app html respond <file> done <request id> --text 'Split the chart by day.'
```

For anything longer than one plain line, write the text to a file in the
scratchpad and pass `--text-file <path>`.

## Restarting and wrapping up

`ah restart` makes the server forget open pages; their comments can't be sent
until `ah app html open <file>` runs again, and the old page reconnects and
reloads on its own. The conversation history survives in its log under
`~/.local/state/ah/html/`. When the user is done with the page,
`ah app html close <file>`.
