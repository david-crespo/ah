# Upgrading

ah runs from a checkout, so upgrading is pulling a newer commit and running `ah server restart`. Most changes need nothing more. This page lists the ones that do, newest first, for the agent or person bringing an install up to date.

There are three kinds:

- **ah's state**, in `~/.local/state/ah/` and `~/.cache/ah/`. Its version is in `~/.local/state/ah/version`, and the server migrates it when it starts (`platform/state_version.ts`), writing what it did to its log. Nothing to do. A server whose state is newer than its code, after checking out an older commit, refuses to start; going back isn't supported.
- **Files in people's repos** that load ah's scripts or use its formats, such as tracker and stack pages. Agents write these, so ah never changes them. It finds them among the trackers it has records of and the pages it serves, and `ah doctor` lists the ones in the current workspace (`--all` for every workspace) with what to change in each, for an agent to do and check. ah keeps reading the old format, so a page that hasn't been changed yet still works, with a banner saying it's out of date.
- **Setup**: each harness's copies or links of ah's skills, and Claude Code's hooks (the other harnesses' hooks aren't checked). `ah doctor` lists what's wrong and the command that fixes each, which it doesn't run.

A session starting in a workspace with old files is told to run `ah doctor` and to offer the user the changes rather than make them unasked. Setup problems are the user's to fix, so agents aren't told about them. While there are any, the dashboard shows a warning icon, with a popover that lists each problem and the command that fixes it.

## Stack pages on jjack

Stack pages use [jjack](https://github.com/david-crespo/jjack) as a library in place of the `jj spr` command. Clone it next to ah's checkout, at `../jjack`, and run `npm install` in ah's before restarting the server. Stack files and jj config need no changes. jjack reads and writes jj-spr's stack file format, and each `jjack.*` config key falls back to the key jj-spr reads. Land now runs the sync itself after merging. Sync is still there for PRs merged some other way and for a land whose sync stopped.

**Setup.** The ah-stack skill refers to the jjack skill, at `skills/jjack` in jjack's checkout, in place of the jj-spr skill. The server needs no `jjack` command, but agents run it from their shell. jjack's README has how to install it. `ah doctor` checks for neither the command nor the skill.

## skepsis hosted in the server

A stack page's diff buttons open skepsis in the server, at `/view/skepsis/<id>/` on the API port, rather than starting a separate skepsis process. ah no longer reads `AH_SKEPSIS`, so remove it from the server's environment. skepsis windows that were open show a 404 or a closed connection after the restart; click the diff stat again.

## Views renamed doc and page

**State version 1.** The thread logs moved from `~/.local/state/ah/markdown/` and `html/` to `doc/` and `page/`, and the GitHub cache from `~/.cache/ah/markdown/` to `doc/`. Where both directories had a log for the same file, the newer one was kept.

**Pages.** Tracker pages load `/task_list.js` from the root of the pages port, where it'll stay, in place of `/view/html/task_list.js`. In each page's script tag, change the `src` to the new path: `<script type="module" src="/task_list.js"></script>`. Nothing else on the page changes. Pages in `.claude/notes` aren't versioned, so check each edit before moving on.

**Setup.** The skills are named `ah-doc`, `ah-page`, `ah-panes`, `ah-skepsis`, `ah-stack` and `ah-tracker`. All but `ah-stack`, which is new, replace a skill without the prefix: `markdown`, `html`, `panes`, `skepsis` and `tracker`. Links to the old names no longer resolve, and copies under them are stale: `ah doctor` lists both. Comment headers now start "Doc requests" and "Page requests".

**Open windows** on `/view/markdown/…` or `/view/html/…` URLs show a 404 after the restart. Open the file again.

## Commands grouped under `ah tool` and `ah window`

The commands that open a UI are under `ah tool`, and the ones that list and close windows under `ah window`. The old names are gone, with no aliases, so change them wherever they're written down: shell aliases, editor config, a skepsis `--open-cmd`. ah's own skills and Helix modules already use the new ones, and `ah doctor` doesn't look for the old ones.

| Before                                   | Now                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `ah view open <file>`                    | `ah tool doc <file>` for markdown, `ah tool page <file>` for HTML |
| `ah view merge`                          | `ah tool doc merge`                                               |
| `ah view ls`, `ah view close`            | `ah window ls`, `ah window close`                                 |
| `ah tracker add`, `ls`, `park`, `finish` | `ah tool tracker add`, `ls`, `park`, `finish`                     |
| `ah dashboard open`                      | `ah tool dashboard`                                               |
