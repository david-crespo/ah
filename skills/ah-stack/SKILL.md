---
name: ah-stack
description: "Show a jj-spr stack file as a page: each PR's commits and diff stats, newest first, with buttons that open any commit's or PR's diff in skepsis and Push, Land, and Sync buttons the user clicks to run jj-spr. Use when the user asks for a stack page, or wants to see how a stack of jj changes splits into PRs."
---

# Stack pages

A stack page shows a jj-spr stack file the way the user reviews a stack:
newest first, like `jj log`, each PR with its tip, its files, and a line per
commit that opens to the commit's description and files. jj-spr owns the
file and pushes the PRs. ah draws the page from the file, from jj, and from
`jj spr stack-file status`.

The jj-spr skill covers the stack file and jj-spr's commands: the format,
changing a stack, what to do when a command refuses, and taking over a stack
that was pushed with `jj git push`. Read it before writing or changing a
stack file. This skill covers the page.

Run every `ah` command as the whole Bash command, as the ah-page skill says (in
Claude Code: no pipes, `&&`, redirects, or `$`), or it runs in the sandbox and
fails.

## Starting one

A stack lives in a directory of its own,
`.claude/notes/<YYYY-MM-DD>-<slug>-stack/`, which jj ignores. Make the stack
file first, from the tip of each PR, bottom to top:

```
jj spr stack-file init .claude/notes/2026-11-05-versioned-docs-stack/stack.json --tips 'vdocs-release-data | vdocs-routes | kxqzwmvtnlop'
```

Each tip has to be an ancestor of the next. Each becomes an entry with the
change's bookmark if it has exactly one, else its change ID, and a title from
its description. Then open the page:

```
ah tool stack .claude/notes/2026-11-05-versioned-docs-stack/index.html --title 'Versioned docs stack'
```

ah writes `index.html` next to the stack file, opens it in a window, and
binds it to this session. Without a stack file there, it writes an empty one
to fill in. Run the same command without `--title` to open an existing page.
With no file, it looks for stack pages in this workspace's `.claude/notes`:
it opens the only one, or with several, the user picks one in the terminal,
so give a path when you know which one you want.

## The stack file

```json
{
  "title": "Versioned docs stack",
  "notes": ["The schema change in 2 has to be live before 3 can deploy."],
  "prs": [
    { "tip": "vdocs-release-data", "body": "vdocs-release-data.md" },
    { "tip": "vdocs-routes", "body": "vdocs-routes.md" },
    { "tip": "kxqzwmvtnlop", "title": "Serve docs by release" }
  ]
}
```

`title` and `notes` at the top are ah's. jj-spr keeps them:

- `title` is the page's heading.
- `notes` are plain-text paragraphs (backticks for code) for context that
  belongs to no one PR, such as a PR that's been tabled. What a PR does goes
  in its body.

Everything under `prs` is jj-spr's format. The page numbers the PRs by
place, so don't number titles. After editing the file, check it with
`jj spr stack-file status <file>`. The page shows the same problems and
planned actions on each PR.

## Bodies and commit summaries

Write each PR's body before the user pushes it: set its `body` key and write
the file. The page's Body button on a PR with a `body` key opens the file in
a doc page bound to the same agent, starting it with just the title if it
doesn't exist. Comments on it come to you as the ah-doc skill describes.
Later pushes send the file's changes to GitHub.

A commit's summary on the page is its description's body, under the title
line. Write it when you make the commit (`jj describe`). After squashing,
splitting, or moving changes between commits, reread each changed commit's
diff and update its body to match.

## The page

The page redraws when the stack file or a body changes and after each jj
operation. Merged PRs start folded to one line. When the user folds or
unfolds a PR, the page keeps that choice. Once a PR is on GitHub, the page
shows its state, checks, review, and GitHub stack, and it reads them again
every minute while it's in view.

Each diff stat (`+12 −3`) on a PR or commit is a button that opens that diff
in skepsis. After a push, the commits changed since are tagged new or
changed, and a changed PR has a tag by its diff stat. A changed tag opens the
interdiff: what changed apart from moving onto new parents. Comments sent from
skepsis come to the agent the page is bound to as messages; treat them as the
user's. A second click on the same diff brings its window forward rather
than opening another. The server hosts skepsis itself. If a button has a red
outline, its tooltip has the error.

## Pushing, landing, and syncing

A PR that a push would change has a Push button, which runs
`jj spr submit <file> --upto <tip>` for it and the PRs below it. Push all,
under the title, runs it for the whole stack. When the push adds commits to
open PRs, a field by the button has their message, drafted from what changed
since the last push. Left blank, it's "Update". A PR has Land
(`jj spr land --upto`) once it and the PRs below it are open on GitHub with
nothing to push. Land all shows once every PR is. Once GitHub has merged a PR
that the stack file doesn't mark merged, Sync runs `jj spr sync`, which
abandons the merged changes, rebases the rest onto trunk, and marks those PRs
merged.

Clicking a button opens a native sheet in ah's window for the page with what
the command will do. Only confirming there runs it, and jj-spr's output shows
on the page. In a browser tab, the buttons are disabled, since only ah's
window can show the sheet.

These are the user's actions. Never call the page's routes for them. When the
user asks you to push, run `jj spr submit <file> [--upto <tip>] -m '<message>'`
from your shell, or point them at the button. Push a stack file's PRs only
through jj spr with the file, never with `jj spr diff` or `jj git push`.
