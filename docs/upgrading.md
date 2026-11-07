# Upgrading

ah runs from a checkout, so upgrading is pulling a newer commit and running `ah server restart`. Most changes need nothing more. This page lists the ones that do, newest first, for the agent or person bringing an install up to date.

There are three kinds:

- **ah's state**, in `~/.local/state/ah/` and `~/.cache/ah/`. Its version is in `~/.local/state/ah/version`, and the server migrates it when it starts (`platform/state_version.ts`), writing what it did to its log. Nothing to do. A server whose state is newer than its code, after checking out an older commit, refuses to start; going back isn't supported.
- **Files in people's repos** that load ah's scripts or use its formats, such as tracker and stack pages. Agents write these, so ah never changes them. It finds them among the trackers it has records of and the pages it serves, and `ah doctor` lists the ones in the current workspace (`--all` for every workspace) with what to change in each, for an agent to do and check. ah keeps reading the old format, so a page that hasn't been changed yet still works, with a banner saying it's out of date.
- **Setup**: each harness's copies or links of ah's skills, and its hooks. `ah doctor` lists what's wrong and the command that fixes each, which it doesn't run.

A session starting in a workspace with old files, or on a machine with setup problems, is told to run `ah doctor` and to offer the user the changes rather than make them unasked.

## Views renamed doc and page

**State version 1.** The thread logs moved from `~/.local/state/ah/markdown/` and `html/` to `doc/` and `page/`, and the GitHub cache from `~/.cache/ah/markdown/` to `doc/`. Where both directories had a log for the same file, the newer one was kept.

**Pages.** Tracker and stack pages load `/task_list.js` and `/stack.js` from the root of the pages port, where they'll stay, in place of `/view/html/…` (and briefly `/view/page/…`). In each page's script tag, change the `src` to the new path: `<script type="module" src="/task_list.js"></script>` (or `/stack.js`). Nothing else on the page changes. Pages in `.claude/notes` aren't versioned, so check each edit before moving on.

**Setup.** The skills are named `ah-doc`, `ah-page`, `ah-panes`, `ah-skepsis`, `ah-stack` and `ah-tracker`, in place of `markdown`, `html`, `panes`, `skepsis`, `stack` and `tracker`. Links to the old names no longer resolve, and copies under them are stale: `ah doctor` lists both. Comment headers now start "Doc requests" and "Page requests".

**Open windows** on `/view/markdown/…` or `/view/html/…` URLs show a 404 after the restart. Open the file again.
