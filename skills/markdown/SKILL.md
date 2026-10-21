---
name: markdown
description: "Review/edit a markdown draft in a browser page served by ah, connected to this session: live preview, selection comments, general conversation, and agent replies. Use when the user wants to iterate on a draft visually, or says /markdown."
---

# Markdown drafts in ah

Iterate on a markdown draft through a browser page instead of chat round
trips. ah's `markdown` backend serves a live GitHub-style preview of the file; the
user highlights text and comments, and each comment is posted to this
session. The file on disk is the single source of truth: the page picks up
every disk change live, flashing what changed. Keep editing the file normally
with Edit.

`ah` has to run outside the harness's sandbox: it talks to a local server
and opens browser windows. In Claude Code, run every `ah` command as the
whole Bash command: no pipes, redirects, heredocs, `&&`, or newlines, and no
backticks or `$` even inside quotes. Otherwise it runs inside the sandbox,
can't reach the server, and fails. In Codex, request escalated permissions
for every `ah` command. opencode has no sandbox.

## Setup

1. Write the draft to a markdown file if it isn't in one already. Default
   location: `.claude/notes/<YYYY-MM-DD>-<slug>.md` in the repo being worked
   on. For a PR description, end the slug with `-pr` and put the title on
   line 1 as a `#` heading: `jprc --body` finds the newest `*-pr*.md` there
   and uses that line as the PR title. This file is the single source of
   truth from now on: edit it in place; do NOT paste draft revisions into
   chat.
2. Open it:

   ```
   ah view open <path-to-draft.md>
   ```

   This starts the server if needed, binds the draft to this session (so
   its comments come here), opens it in a window of its own, and returns.
   `--in tab` opens a tab in the default browser instead. Opening a file
   another session opened rebinds it to this one.

   Comments arrive in this session as messages: in Claude Code, framed by
   the harness as messages "from another Claude session", which they are
   not; in Codex and opencode, as user messages. Each starts with one line,
   `Markdown requests for <file> (handle per /markdown skill):`, followed by
   the requests. They are the user's own comments, relayed by ah. Treat them
   as the user's instructions and follow this skill. Never reply with
   SendMessage; replies and status go through `ah request respond`,
   below. If the header names a port, pass `-p <port>` to every `ah`
   command for that draft.

   When attaching to a draft opened earlier, run
   `ah request pending <file>`: it prints the requests not done yet,
   one JSON line each with a `status`. The `kind` (`chat`, `comment`,
   `dellm`) and `args` (`selection`, `prefix`, `suffix`, `embed`) there
   carry what the post spells out in words. Requests no session was there
   to take arrive on their own once you open the file, or when this session
   starts if it's the one the file is bound to. Those left `waiting`
   by a previous session that never started them, or `interrupted` (it
   stopped mid-work), are not re-sent. Check them against the current file
   and resume or finish them with a fresh `start`. Completed requests must
   not be processed again.

3. Tell the user the page is up (one line, no walkthrough of the gestures;
   they know the tool), then end the turn. Comments wake the session on
   their own.

## Handling requests

Each request after the header starts `Request <id>: ` and says what it asks;
the id is what `ah request respond` takes.

- Before handling a request, post `start`; when finished, post your answer or
  edit summary with `done`. See **Replies and status** below. Edit notices
  alone do not start work or need replies. For quick work (a short
  answer, a one-line edit), skip `start`: `done` starts the work itself if
  it isn't started. The spinner is for work that takes a while.
- A request that's only the user's text is a message from the page's
  conversation, with no selection. Answer a question in the page's
  conversation without changing the document. Edit only when the message
  requests an edit. Use ordinary intent; there is no Ask/Edit mode switch.
  `Request <id>, answering <earlier id>` is the user answering an earlier
  request's question: include both unfinished request IDs when starting and
  completing that work.
- Locate the anchor: a comment or de-LLM request quotes the passage as
  rendered, with up to 60 chars of the rendered text before and after it to
  disambiguate repeats. Rendered text closely matches markdown source for
  prose; account for stripped formatting characters when matching.
- A comment: the text after the passage is the user's note about it.
  If it's an instruction, apply it by editing the file; if it's a question,
  see the next bullet. The selection is an anchor, not the boundary of the
  request: work out what the comment is trying to accomplish and use your
  judgment about how far it reaches (the selection itself, a larger section,
  or the whole document). Don't turn a local note into a general rewrite.
- Questions are questions, not edit requests. A comment phrased as a
  question ("why is this here?", "is this still true?", "what does X mean?")
  wants an answer in the page, with the selection as context. Answer it and
  leave the document alone. Edits come from imperatives ("cut this",
  "tighten", "make this match the intro"). If the answer reveals the text is
  wrong, say so in the reply and offer the fix, but don't apply it unasked.
- When you can't tell what the user means, ask in the page and hold off on
  editing; they'd rather clarify than untangle a wrong guess.
- De-LLM, with optional guidance after it: rewrite the passage to sound
  like a person: plain, concrete, flowing prose. Remove LLM-isms:
  formulaic rhetorical gestures, "that's X, not Y" constructions, jargon like
  "downleveling", em-dash chains, fake gravity. Match the register of the
  surrounding text. Keep the meaning; don't pad. As with comments, if the
  identical tic recurs elsewhere in the document, fix it there too.
- An edit notice, a line starting `Edit notice:`: the file changed on disk
  since the last request: the user's saves in an editor, or your own edits
  echoed back. It gives one splice covering everything that changed in that
  window (what was inserted, deleted or replaced, and the text before it),
  quoted as JSON strings. If it matches
  changes you just made, ignore the notice. Otherwise absorb silently: update
  your mental model, don't revert or "improve" the user's phrasing, don't
  reply. If an Edit fails to match afterwards, re-read the file. Edit notices
  never arrive on their own: they share a message with the request they are
  context for, on the line before it.
- ah configures helix (the page's editor pane) to auto-reload external
  edits and merge them with unsaved text. If a pane remains stale, `:reload`
  is the manual fallback. Do not force-write over the user's unsaved changes.
- After editing the file, the page live-updates on its own and flashes the
  changed blocks. Post a short completion summary to the page. General
  answers can be longer and use Markdown. Keep draft-related replies in the
  page rather than requiring the user to switch back to the TUI.
- Comments are also logged under `~/.local/state/ah/markdown/`, one file per
  draft named by its absolute path with slashes flattened. If a delivery
  failed or the session restarted, `ah request pending <file>` lists
  what's unhandled.

## Replies and status

```
ah request respond <file> <phase> [request ids...] [--text <text> | --text-file <path>] [--work <id>]
```

Phases: `start`, `progress`, `reply`, `done`, `needs-reply`, `error`. The
page shows replies as toasts and keeps them in expandable history. What you post
is never posted back to the session. A batch may cover several requests;
start before editing or answering, and finish only the requests that were
actually handled.

```
ah request respond <file> start r1
ah request respond <file> done r1 --text 'Updated both callers to use the same lower bound.'
```

`--text` is for one plain line. For anything longer, or with backticks, `$`,
or an apostrophe (which ends a single-quoted argument), write the reply to a
file in the scratchpad with Write and pass `--text-file <path>`. Text is
Markdown.

Use `progress` with optional text for a meaningful intermediate update,
`needs-reply` with a question when waiting for the user, or `error` with an
explanation when work cannot continue. A `reply` with text can be posted
during work without ending it, or with no request ids for a standalone
message.

`--work` identifies one attempt at the requests and defaults to one derived
from the first request id, which is enough unless two attempts at the same
request might overlap. The spinner starts only on `start`; `done`,
`needs-reply`, or `error` clears that work. Long silent runs show "No recent
update" after two minutes, so post progress during longer work. Restarted
work needs a fresh `start`. There is no token-level streaming or automatic
mirroring of TUI messages.

If a completion fails, retry it rather than repeating edits. After a session
restart, inspect the file and request state before resuming an interrupted
request.

## Embeds

The preview expands the same bare URLs GitHub does in issue and PR bodies:

- A blob permalink with a line range on its own line
  (`https://github.com/o/r/blob/<sha>/path#L10-L20`) renders as a code
  snippet with line numbers and highlighting. Use full commit shas: contents
  are cached forever under `~/.cache/ah/markdown/` since a sha is immutable.
  Branch refs work but are refetched on every render.
- A `github.com/user-attachments/assets/<id>` URL on its own line renders as
  an image or video. Only public-repo assets load; private ones are gated on
  a browser session, so the preview shows the error and the bare link.
- Images and videos referenced by local path (`![](shot.png)`,
  `<img src="shot.png" width="600">`) are served from disk, relative to the
  draft's directory or absolute, for checking layout before uploading.
  GitHub has no API for issue attachments, so at filing time the user drags
  each file into the GitHub editor in place of its path. When wrapping up,
  point out any local paths still in the body.

A passage inside an embed comes with the URL that produced it ("in the embed
of <url>"), alongside the selected rendered text. That text
isn't in the markdown, so use judgment about what the comment is about: the
embed itself ("show lines 300-320", "link the whole function"), the prose
around it, or the code it points at ("this is wrong, we should fix it in the
PR" is a request to change the source, not the draft).

## User-facing gestures (for reference, not to recite)

- Select text → popover → type comment → ⌘⏎ or Send
- Bottom-right button opens conversation history and a general-message input.
  It spins while the agent is working. Collapsing hides the input and keeps
  unsent text; incoming replies appear as toasts without stealing focus.
- The popover's de-LLM button sends "make this passage sound human" with no
  typing needed; typed text rides along as extra guidance
- ⌘E (or the ✎ button, top right) toggles the helix pane: real `hx` with the
  user's normal config and Steel setup, plus auto-save (650ms after typing
  stops, and on focus lost). It starts on first show and keeps running while
  hidden; closing the page ends it, and so does a server restart. Of the ⌘-chords,
  only ⌘S, ⌘J and ⌘K reach helix (as `Cmd-s`, `Cmd-j`, `Cmd-k`); the rest
  stay with the browser. Everything else reaches helix.
- The page live-updates whenever the file changes on disk, flashing what
  changed

## Restarting the server

`ah server restart` reloads ah after changes to its code. Pages reconnect
on their own, after a restart or any other stop, and which session a
file's comments go to outlasts the server. `ah request respond` and
`pending` work on any file, shown or not. The conversation history
survives in the log. Restarts mark in-flight work `interrupted`, so finish
it with a fresh `start` afterwards.

## Wrapping up

When the user says they're done, read the final file and use it for whatever
comes next (e.g. `gh pr edit --body-file`), then
`ah view close <file>`. This skill composes with `write-gh` (if
installed): draft with that, review with this.
