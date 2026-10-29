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
ah tracker add .claude/notes/2026-10-15-post-rex-review-tracker/index.html --title 'Post-Rex review' --goal 'Clean up what the port left behind, then pick the next features.'
```

A new tracker goes in `.claude/notes/<YYYY-MM-DD>-<slug>-tracker/index.html`,
today's date and a kebab-case slug, in a directory of its own. `ah tracker
add` writes it from the template if it isn't there, adds it to the
workspace's active trackers (back from parked or done if it was), makes it
the current one, which the dashboard shows in every tab on the
workspace, and binds it to this session. To bind an existing tracker to
this session, as when picking work back up in a new one, run
`ah tracker add <path>`. The binding outlasts server restarts. If it
fails, mention it in a line and move on.

Picking up: the SessionStart hook names the workspace's current tracker.
`ah tracker ls` lists the workspace's active ones, the current one marked
`*`, then the parked ones; `ah tracker ls --done` lists the finished ones.
Take the one that fits the request (ask if it's unclear). If there's an
existing tracker for the work, use it rather than starting another, even a
parked or finished one: adding it puts it back in the list. Older trackers
are markdown (`*-tracker.md`); keep working in one of those as it is unless
the user asks to convert it.

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
    (<code>views/cli.ts:42</code>), and what was decided.
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
- `status`: `todo` (the default), `doing`, `done`, `dropped`, `hold`
  (set aside), `question` (waiting on the user's answer). For a question,
  put it in the detail, under `<h4>Open</h4>` with the options, and ask it
  in chat too. When it's answered, record the answer under `Decided` and
  move the item on.
- `rev`: the jj change ID once there is one. Leave it off until then.
- The `<h3>` is the title: a few words. Everything after it is the detail,
  collapsed under the title. Put all of it there. There's no separate review
  file. Use `<p>`, `<ul>`, `<code>`, `<a>`. The detail should be enough to act
  on without the conversation.
- Work that takes more than one rev gets steps, in order, each with its own
  `status` and `rev`. The page shows each step's status icon, and a dot per
  step in its status's color on the item's title line, so the user can see
  where things are.
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
around the items; the stylesheet and `task_list.js` own all of that.

## Keeping it current

- Update it in the same turn something is decided, finished or added, and say
  so in a line in chat.
- Mark items `done` or `dropped` in place, with the change ID; never delete
  them.
- In chat, refer to items by ID and a short label: "4 (tracker skill)".
- Work one item at a time and stop for review after each, unless the user has
  said to run through several. Keep items in separate revs where practical,
  and keep tracker IDs out of rev descriptions.

## Where answers go

The tracker has the html skill's conversation panel, in the dashboard too.
The user reads it either beside the terminal or on another screen, so every
answer goes in both places, in full where the request came from and as a
summary of a line or two in the other:

- A message from the conversation panel, an item comment, or a selection
  comment: the full answer in the page (`done` with the text), and a
  summary in the terminal ("Answered in the tracker: …").
- Go: the work and the full account of it in the terminal, and a one-line
  summary in the page (`done` with what was done and the rev).
- A status pick needs no answer: the icon shows the new status.

## The Go button

Each `todo` and `hold` item has a Go button; a `question` item doesn't, since
it waits for an answer. A click wakes the session with an
HTML request (the html skill's format; in Claude Code it's framed as a message
"from another Claude session", which it isn't) that reads
`Go ahead with item <id>: <title>`: the user's instruction to start that
item, like typing "do 4". The page shows a spinner on the button until you answer
the request:

1. `ah message respond <file> start <request id>`, and set the item to
   `status="doing"`.
2. Do the work and report it in the terminal, as for any request.
3. `ah message respond <file> done <request id> --text '<one line>'`, and
   update the item (`done`, `rev`). The spinner clears.

If you need to ask before going ahead, ask in the terminal and post
`needs-reply` for the request with the question in a line: the button
shows a question mark. `error` shows a warning sign.

## Comments

Each item also has a comment button, left of Go, that opens a box for a note
about that item. It arrives the same way, as
`a comment on item <id>: <title>`, a blank line, then the user's text. Treat it like
a message about that item: answer a question, make a requested change to the
item or the work, and post `done` with the answer when finished. The comment
button shows the same spinner and states as Go until then. A comment is not a
Go: don't start the item's work unless the comment asks for it. Selection
comments on an item's text work the same way.

Clicking an item's or step's status icon opens a menu of statuses, and a
pick arrives as `set item <id> to <status>: <title>` (or `step 3B`). Set
that status in the file, as the user's own change, and post `done` for the
request. The icon shows a spinner until then.

## Finishing

The user usually parks or finishes a tracker with the buttons by its title.
When the goal is done, `ah tracker finish <path>` marks the tracker done and
takes it out of the list; `ah tracker park <path>` sets it aside with work
left, until it's added again. If it was current, the tracker used before it
becomes current.

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
first column of `ah view ls`, and an html page can go alongside the
tracker. It prints a URL per page to give the user. The page doesn't reload
live (pull to refresh) and comments and Go don't work from it: the proxy
passes only GETs and no socket. Stop it when the user is back.
