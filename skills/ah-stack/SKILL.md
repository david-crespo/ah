---
name: ah-stack
description: "Show a stack of PRs as a page: each PR's commits, diff stats and summary, newest first, with buttons that open any commit's or PR's diff in skepsis and a Push button the user clicks to push a PR. Use when the user asks for a stack page, or wants to see how a stack of jj bookmarks splits into PRs."
---

# Stack pages

A stack page shows a stack of PRs the way the user reviews one: newest first,
like `jj log`, each PR with its bookmark, a summary, its files,
and a line per commit that opens to the commit's description and files. ah
draws it from jj, and you write only what jj doesn't know.

Run every `ah` command as the whole Bash command, as the ah-page skill says (in
Claude Code: no pipes, `&&`, redirects or `$`), or it runs in the sandbox and
fails.

## Starting one

```
ah tool stack .claude/notes/2026-11-05-versioned-docs-stack/index.html --title 'Versioned docs stack'
```

A new stack goes in `.claude/notes/<YYYY-MM-DD>-<slug>-stack/index.html`, in a
directory of its own. ah writes the page and a `stack.json` next to it, opens
it in a window, and binds it to this session. Run the same command without
`--title` to open an existing one.

## stack.json

```json
{
  "title": "Versioned docs stack",
  "notes": ["The schema change in 2 has to be live before 5 can deploy."],
  "prs": [
    {
      "n": 1,
      "title": "Track system releases",
      "bookmark": "vdocs-release-data",
      "summary": "What the PR does.\n\nWhere a reviewer should start."
    }
  ]
}
```

- `n` is the PR's place in the stack, and the page shows it as `1.`, so don't
  number titles or bookmarks. Keep the numbers in stack order. When a PR is
  inserted or moved and no PR above that place has been pushed, renumber the
  ones above it, and update the numbers that `merge`, `notes` and summaries
  refer to. Once a PR above has been pushed, people know it by its number, so
  leave the numbers alone and give the new PR the next free one.
- Don't list commits or bases. ah takes each PR's commits from the graph: the
  bookmark's ancestors down to the nearest other PR's bookmark, a fork, or
  trunk. Commits below a fork that no PR's bookmark is on get a card of their
  own, shared by the PRs above, since each of them would include those
  commits on GitHub. The page draws the graph the way `jj log` does.
- `merge` is optional: a few words on how the PR merges, shown after its
  bookmark. Leave it out unless it says something the graph and GitHub
  don't, such as a PR on a side branch that has to merge before one on the
  main line. Never use it to restate the stack's order or what's pushed.
- `notes` is a list of plain-text strings, each one paragraph. `summary` is
  plain text with blank lines between paragraphs. Both take backticks for
  code. Write the summary for a reviewer: what the PR does, then where to
  start reading.
- A PR can be listed before its bookmark exists; the page shows it with "no
  bookmark yet" until it does. Keep a PR listed after it merges, even once a
  fetch deletes its bookmark: GitHub still knows it by its branch, so the
  page puts it with the other PRs that have no commits of their own.
- Each PR's card folds to one line (its title, its state on GitHub and its
  diff stat). Merged PRs start folded; the user's own choice wins and is
  kept.
- The page redraws when `stack.json` or a PR's body changes and when a jj
  operation lands, so rewriting commits or moving bookmarks shows up on its
  own.

## Commit summaries

A commit's summary is its description's body, under the title line. The page
unwraps hard-wrapped lines and keeps paragraphs. Write each one when you make
the commit (`jj describe`), and after restructuring the stack (squashing,
splitting, moving changes between commits), reread each changed commit's
diff and update its body and its PR's `summary` to match.

## The diff buttons

Each diff stat (`+12 −3`) on a PR or commit is a button. Clicking it has the
server open that diff in skepsis: `-r <change>` for a commit,
`--from <base> --to <bookmark>` for a PR. Comments sent from skepsis come to
the agent the page is bound to as messages; treat them as the user's. A
second click on the same diff brings its page back rather than starting
another. The server runs skepsis with `AH_SKEPSIS` from its environment
(like `node /Users/me/skepsis/cli.ts`: an absolute path, since it runs
without a shell to expand `~`), else `skepsis` on PATH; if a button outlines
red, its tooltip says why.

## Pushing

A PR with commits still to push has a Push button on the bar that marks
them, and a PR whose bookmark isn't on the remote yet has one by its Body
button. Clicking it has ah's window for the page show a sheet listing the
commits the push would send; only clicking Push there runs
`jj git push --bookmark` for that PR, and jj's answer shows on the PR. The
sheet is native, so a page's script can't click it, and only ah's window can
show it: in a browser tab the button says to push from the window.

For a bookmark that isn't on the remote yet, the button says "Push and
create PR": once the push works, the server opens the PR with
`gh pr create`. Its title is the heading on line 1 of the PR's body file
(else its `title` in stack.json) and its description the rest of the file.
Its base is the bookmark of the PR it's built on in the graph if that PR is
open on GitHub, else trunk. The sheet shows the title and base first, and
says if the description is empty, so write the body before the user
pushes. If the PR fails to open, the push stands and the page shows why;
open the PR by hand then. A bookmark already on the remote opens no PR. A push that would rewrite
commits the remote has is refused, to be pushed by hand. Pushing from the
page is the user's action: never call the page's push route yourself. When
the user asks you to push, push from your shell as usual, or point them at
the button.

## PR bodies

A PR's GitHub description is drafted in `<bookmark>.md` next to `stack.json`
(each `/` in the bookmark as `--`), with the PR title as a `#` heading on line 1. Once the file has that heading,
the page shows it as the PR's title in place of the one in `stack.json`. Each
PR has a Body button that opens its file in a doc page bound to the same agent
as the stack page, starting the file with just the title if there isn't one.
Comments on it come to you as the ah-doc skill describes.

## GitHub

Once a bookmark has a PR on GitHub, the page shows it from `gh`: a link
with its state (draft, open, merged, closed), its title from GitHub, and,
while it's open, its review and checks. It flags a PR whose head on GitHub
has changed since the last fetch and one whose base on GitHub isn't the PR
below it, or trunk for the bottom one. Commits still to push are marked in
the commit list, not on this line. GitHub has the body from then on, so the Body
button goes away. The page asks GitHub again every minute while it's in
view.
