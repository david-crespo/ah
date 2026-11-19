---
name: ah-workstream
description: "Show a batch of in-flight work spread over several jj workspaces as one page: what each piece is and its status, its revs with diff stats that open in skepsis, its notes and PR drafts with buttons that open them, and its open questions. Use when the user wants one page for work you have going in several workspaces or repos at once, or asks for a workstream page."
---

# Workstream pages

A workstream page shows a burst of work that spans several jj workspaces,
often in more than one repo, as cards under group headings. Each card is one
piece of work: a status, a title, its revs' total diff stat, and the number
of open questions. Opened, it has a summary, the workspace, the open
questions, PR drafts, notes, and the revs, newest first, each with its
description and files. Every diff stat opens that diff in skepsis: a rev's
opens the rev, and the card's opens the whole range. Every note and PR draft
has an Open button.

The page is a template, `index.html`, that draws `data.json`. You write
`work.json`. A generator, `gen.ts`, adds each item's revs and diff stats from
jj, and the titles of its notes and PR drafts, to make `data.json`. A page is
for one burst of work and is thrown away after it. When the work is pushed or
dropped, delete the page's directory rather than reusing it for the next
batch.

Run every `ah` command as the whole Bash command, as the ah-page skill says (in
Claude Code: no pipes, `&&`, redirects, or `$`), or it runs in the sandbox and
fails.

## Starting one

Make a directory directly in `.claude/notes` of the repo you're working in,
named `<YYYY-MM-DD>-<slug>-workstream`, and copy the template and generator
from this skill's directory into it:

```
mkdir -p .claude/notes/2026-11-05-authz-workstream
cp <this skill's directory>/index.html <this skill's directory>/gen.ts .claude/notes/2026-11-05-authz-workstream/
```

Write `work.json` there, then run the generator and open the page:

```
node .claude/notes/2026-11-05-authz-workstream/gen.ts
ah tool page .claude/notes/2026-11-05-authz-workstream/index.html
```

The generator takes the page's directory as an argument, by default its own.
It writes `data.json` and `workspaces.json`. The second lists the items'
workspaces, so the page can open diffs in workspaces of other repos (see
"Diff and note buttons" in the ah-page skill).
It runs `jj log` in each item's workspace, which snapshots that workspace's
working copy, so in a sandbox it needs write access to those repos. It prints
the number of revs it found and any jj errors, which also show on their cards.

Comments and messages on the page come to you as the ah-page skill describes.

## work.json

```json
{
  "title": "Authz fixes and custom roles",
  "subtitle": "Nothing is pushed yet.",
  "groups": [
    {
      "title": "Ready to PR",
      "items": [
        {
          "title": "Require fleet admin for the alert receiver probe",
          "status": "ready",
          "repo": "omicron",
          "base": "on main",
          "workspace": "/Users/me/jj-workspaces/omicron-probe-authz",
          "revset": "trunk()..@ & ~empty()",
          "summary": "The probe only checked `fleet.viewer`.",
          "notes": ["2026-11-05-authz-audit.md"],
          "prs": ["probe-authz"],
          "open": ["Should collaborators be able to probe?"]
        }
      ]
    }
  ]
}
```

- `title` is the page's heading. `subtitle`, optional, goes under it.
- `groups` are the headings, in order, each with a `title` and its `items`.
- Each item has a `title` and a `status`. `ready` (waiting on the user's
  review), `running` (an agent is working on it), `parked` (kept for
  reference), `done`, and `notes` (notes, no code) each have a color and a
  legend entry. Any other status shows in gray. The title is also the key the
  page uses to remember which cards are open, so keep titles unique.
- `summary`, optional, is a sentence or two on what it is and where it
  stands.
- `workspace` and `revset`, optional, are the workspace root as an absolute
  path and the revs to show, which jj resolves in that workspace, so `@` is
  its working copy. Keep the revset to the work itself, such as
  `trunk()..@ & ~empty()`. An item without both has no revs.
- `repo` and `base`, optional, are text shown before the workspace path, as
  in `omicron, on main · ~/jj-workspaces/omicron-probe-authz`.
- `notes`, optional, are paths from the `.claude/notes` the page's directory
  is in, whatever the item's `workspace`. Markdown and AsciiDoc files open in
  a doc page, HTML files in a page. The generator takes each title from a
  heading on the file's first line or from its `<title>`, and uses the path
  for a file with neither.
- `prs`, optional, are slugs of PR drafts, each in `pr/<slug>.md` in the
  page's directory, with its title as a heading on the first line. A draft
  whose file doesn't exist yet shows as being drafted.
- `open`, optional, are the open questions.

Backticks in a summary, title, or question show as code.

## Keeping it current

`data.json` is a snapshot from the generator's last run. The page shows when
that was. Rerun the generator after editing `work.json`, after adding or
retitling a note or PR draft, and after jj changes in any of the workspaces:
new commits, a rebase or squash, or edits to a working copy. The page reloads when any file in its directory changes, so a
rerun shows up on its own, and cards that were open stay open.
