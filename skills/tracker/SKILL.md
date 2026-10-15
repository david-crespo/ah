---
name: tracker
description: "Keep a task tracker as an HTML page in the dashboard: one item per piece of work with its detail collapsed under it, and a Go button the user clicks to have you start an item. Use when the user asks for a tracker, when a review has more than a couple of numbered findings, or when picking up work from an existing tracker."
---

# Task trackers

A tracker keeps the user in control of multi-step work: the goal at the top,
each piece of work as an item with a stable ID, and its state as you go. It's
an HTML page in the dashboard beside the terminal, bound to this session. Its
look and structure come from ah: you write items, nothing else.

Run every `ah` command as the whole Bash command, as the html skill says (in
Claude Code: no pipes, `&&`, redirects or `$`), or it runs in the sandbox and
fails.

## Starting or picking one up

```
ah app page open --tracker --in dashboard .claude/notes/2026-10-15-post-rex-review-tracker/index.html --title 'Post-Rex review' --goal 'Clean up what the port left behind, then pick the next features.'
```

A new tracker goes in `.claude/notes/<YYYY-MM-DD>-<slug>-tracker/index.html`,
today's date and a kebab-case slug, in a directory of its own. `--tracker`
writes it from the template if it isn't there, and `--in dashboard` shows it
as this session's file in the dashboard, bound to the session. To show an
existing tracker again, run `ah app page open --in dashboard <path>`: when
picking work back up, and if the server stopped other than by `ah server restart`,
which keeps the page bound to the session. If it fails, mention it in a line and move on.

Picking up: after a `/clear` the SessionStart hook names the session's
tracker. In a fresh session, find it with `ls -td .claude/notes/*-tracker/`
and take the newest one that fits the request (ask if it's unclear). If
there's an existing tracker for the work, use it rather than starting
another. Older trackers are markdown (`*-tracker.md`); keep working in one of
those as it is unless the user asks to convert it.

When starting mid-work, record the existing revs as done items.

## Items

The template has three groups, each hidden until it has an item. Put each
item in the one that fits:

- `Needed`: the goal needs it.
- `Cleanup`: worth doing, but the goal doesn't depend on it.
- `Unrelated`: found on the way.

```html
<ah-item id="4" status="doing" rev="uqlqlkol">
  <h3>Tracker skill and the CLAUDE.md pointer</h3>
  <p>
    What's wrong or wanted, what to change, with file references
    (<code>app/html/cli.ts:42</code>), and what was decided.
  </p>
  <ul>
    <li>Lists for several parts.</li>
  </ul>
</ah-item>
```

- `id`: a number, counting up in page order. A review's findings keep the
  review's numbers. New items take the next number. When items are
  reordered, renumber them all to match the new order, and update any
  mention of the old numbers in the details.
- `status`: `todo` (the default), `doing`, `done`, `dropped`, `hold`.
- `rev`: the jj change ID once there is one. Leave it off until then.
- The `<h3>` is the title: a few words. Everything after it is the detail,
  collapsed under the title. Put all of it there. There's no separate review
  file. Use `<p>`, `<ul>`, `<code>`, `<a>`. The detail should be enough to act
  on without the conversation.
- Work that takes more than one rev gets steps, in order, each with its own
  `status` and `rev`. The page shows each step's status icon and counts the
  done ones on the item's title line, so the user can see where things are.
  Update a step's status as you go, like an item's. Steps are lettered in
  order, so the second step of item 3 is 3B; refer to them that way in chat.
  Mark a step dropped rather than deleting it, so the letters don't shift.
- A detail that grows past a few paragraphs gets structure: `<h4>` for its
  sections (Steps, Decided, Open), a `<dl>` for labeled lists, and
  `<details><summary>` to fold away what's only background or history.
  Keep what's needed to act next unfolded.

```html
<h4>Steps</h4>
<ah-step status="done" rev="pqqsyksr">One record per agent</ah-step>
<ah-step status="doing">Pages bind to the agent</ah-step>
<ah-step>Show when no agent is connected</ah-step>
<h4>Decided</h4>
<dl>
  <dt>Agent id</dt>
  <dd>The Rex block, or the process outside Rex.</dd>
</dl>
<details>
  <summary>Why not per pane</summary>
  <p>...</p>
</details>
```

Don't add `<style>`, scripts, other elements or groups, or change the page
around the items; the stylesheet and `tracker.js` own all of that.

## Keeping it current

- Update it in the same turn something is decided, finished or added, and say
  so in a line in chat.
- Mark items `done` or `dropped` in place, with the change ID; never delete
  them.
- In chat, refer to items by ID and a short label: "4 (tracker skill)".
- Work one item at a time and stop for review after each, unless the user has
  said to run through several. Keep items in separate revs where practical,
  and keep tracker IDs out of rev descriptions.

## The Go button

Each `todo` and `hold` item has a Go button. A click wakes the session with an
HTML event (the html skill's format; in Claude Code it's framed as a message
"from another Claude session", which it isn't). The event's text is
`Go ahead with <id>: <title>`: the user's instruction to start that item,
like typing "do 4". The page shows a spinner on the button until you answer
the request:

1. `ah app page respond <file> start <request id>`, and set the item to
   `status="doing"`.
2. Do the work and answer in the terminal, as for any request. The dashboard
   is a companion to the terminal, and its conversation panel is hidden.
3. `ah app page respond <file> done <request id>`, with no text, and update
   the item (`done`, `rev`). The spinner clears.

If you need to ask before going ahead, ask in the terminal and post
`needs-reply` for the request: the button shows a question mark. `error`
shows a warning sign.

## Comments

Each item also has a comment button, left of Go, that opens a box for a note
about that item. It arrives the same way, as
`Comment on <id>: <title>`, a blank line, then the user's text. Treat it like
a message typed in the terminal about that item: answer a question in the
terminal, make a requested change to the item or the work, and post `done`
for the request (no text) when finished. The comment button shows the same
spinner and states as Go until then. A comment is not a Go: don't start the
item's work unless the comment asks for it. Selection comments on an item's
text work the same way.

## Finishing

When the goal is done or the work moves elsewhere,
`ah app page close <file>` stops serving it and takes it out of the
dashboard.

## On the phone

When the user is away from the desk but on the same network (Remote Control
from the phone), they can read the tracker in the phone's browser. ah only
listens on 127.0.0.1, so run the read-only proxy next to this file, outside
the sandbox (it binds a LAN port), in the background:

```
node ~/.claude/skills/tracker/lan-proxy.mjs <lan-ip> <page-id>...
```

The LAN IP is the `inet` address on the local network in `ifconfig` output
(`192.168.…`); `ipconfig getifaddr en0` fails in the sandbox. Page ids are the
first column of `ah app page ls`, and an html page can go alongside the
tracker. It prints a URL per page to give the user. The page doesn't reload
live (pull to refresh) and comments and Go don't work from it: the proxy
passes only GETs and no socket. Stop it when the user is back.
