---
name: ah-home
description: "Keep a home page for the user when you coordinate other agents across projects: the live agents and what each was asked, what is waiting on the user, what finished, and every project with its status. Use when you are a concierge or another agent that starts and tracks workers across several projects and the user wants one page to check."
---

# Home pages

A home page is what an agent that runs other agents across projects (a
concierge) keeps for its user. It has four tabs: In progress, the live agents,
each with its project and what it was asked; Waiting on you, the decisions and
reviews only the user can do; Finished; and All projects, every project in the
prose file of projects with its status and its paragraphs.

ah looks up what can be looked up, and you write only the words. Which agents
are running, whether each is working, and each project's status are computed
by ah on every read, so never write them down: a written status goes stale,
which is what this page is for avoiding.

Run every `ah` command as the whole Bash command, as the ah-page skill says (in
Claude Code: no pipes, `&&`, redirects or `$`), or it runs in the sandbox and
fails.

## Starting one

```
ah tool home home/index.html --title 'Concierge'
```

ah writes the page and a `home.json` next to it, opens it in a window, and
binds it to this session, so comments and messages on the page come to you.
Run the same command without `--title` to open an existing one. Keep the
directory versioned if you can: its history shows what was waiting when.

## The prose file

The All projects tab reads a markdown file you keep anyway, by default
`../workstreams.md` relative to `home.json`. Each `## Heading` is a group, and
each paragraph that begins with a bold name ending in a period,
`**Docs versioning.**`, starts a project that runs to the next one or the next
heading. Text before the first `##` and between a heading and its first
project isn't shown. The page renders `code`, `**bold**` and `[text](url)` in
the paragraphs, and shows the first one clamped to three lines until it's
opened.

## home.json

```json
{
  "title": "Concierge",
  "workstreams": "../workstreams.md",
  "projects": [
    {
      "name": "Docs versioning",
      "repos": ["/Users/me/oxide/docs"],
      "prs": ["oxidecomputer/docs#935"],
      "stack": "/Users/me/oxide/docs/.claude/notes/2026-11-05-vdocs-stack/index.html",
      "workers": [{ "session": "8f2c…", "asked": "Answer Joe's three comments on #935" }]
    }
  ],
  "waiting": [
    {
      "id": "joe-935",
      "project": "Docs versioning",
      "text": "Review the rev answering Joe's comments, then push it",
      "written": "2026-11-10T09:27:00-05:00",
      "note": "Open: whether v21 should list Terraform v0.21.0.",
      "link": "https://github.com/oxidecomputer/docs/pull/935",
      "links": [
        { "label": "Suggested replies", "file": "notes/joe-935-replies.md" },
        { "label": "CI run", "href": "https://…" }
      ]
    }
  ],
  "finished": [
    {
      "project": "Docs versioning",
      "text": "Picker design settled on B.",
      "at": "2026-11-10T08:27:00-05:00"
    }
  ]
}
```

- `projects[].name` is the project's name as the prose file has it, without
  the period. A note in parentheses after a name there, as in
  `**ah (doc editor, stack).**`, is ignored when matching, so `"ah"` matches
  it, here and in waiting items.
- `repos` are absolute paths. A live agent whose cwd is one of them or under
  one belongs to the project; the longest match wins.
- `workers` are the agents you started for the project, by ah agent id
  (`agent`) or harness session id (`session`), with `asked`, one line on what
  you asked it to do. The In progress tab shows that line, so a worker you
  list here reads better than one ah only finds by its cwd.
- `prs` are shown as links for now.
- `stack` is the project's stack page (the ah-stack skill), the path to its
  `index.html`. The project gets a Stack button by its name wherever it's
  shown, which opens the stack page in a window bound to you. Do PR work
  there: the home page only points to it.
- `waiting` items have a stable `id` and `written`, the ISO time you wrote or
  last checked the item. The page shows its age, and marks the age of an item
  older than six hours. When an item changes, rewrite it with a new
  `written`; when it's done, remove it and add a `finished` entry.
- The list is in order of what matters most. Each item shows as one line
  until the user opens it, so write its `text` as one line, and its `note`,
  shown only when it's open, as one or two sentences.
- To postpone an item, as when the user says they won't get to it until
  tomorrow, give it `until`, an ISO time. Until then it's left out of the
  list and its count, and doesn't make its project "needs you"; it shows in
  a Postponed section under the list, closed at first, with "until tomorrow
  09:00" or "until 11-14" in place of its age. At that time it's back in the
  list by itself, so you needn't edit it again. An `until` that doesn't parse
  is ignored.
- A waiting item's text links to `link`, a URL, or `file`, and each of its
  `links` has a `label` and an `href` or a `file`. A file is a markdown file,
  which opens in a doc page, or an HTML page, which opens in its page, in a
  window bound to you, as `ah tool doc` or `ah tool page` would open it. Use
  a file rather than the URL of an ah page, which opens in the browser and
  changes with the port.
- Paths in `stack` and `file` are absolute or relative to `home.json`. The
  page opens only files `home.json` lists, so add one there before you point
  the user at it.
- `finished` entries are drawn newest first by `at`.

ah reads the file leniently: an entry missing what it needs is left out, and a
file that isn't JSON shows an error on the page, which keeps what it last drew.

## What's computed

- A project's status is "needs you" while a waiting item that isn't
  postponed has its name, else
  "running" while one of its agents is working, else "idle".
- The In progress tab is every live agent ah knows of, except the one the
  page is bound to (you), working ones first.
- The page redraws when `home.json` or the prose file is saved, and asks for
  the agents every 5 seconds while it's in view.
