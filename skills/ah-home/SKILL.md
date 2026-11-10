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
      "links": [{ "label": "Suggested replies", "href": "http://…" }]
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
- `waiting` items have a stable `id` and `written`, the ISO time you wrote or
  last checked the item. The page shows its age, and dims an item older than
  six hours with "not rechecked since". When an item changes, rewrite it with
  a new `written`; when it's done, remove it and add a `finished` entry.
- `finished` entries are drawn newest first by `at`.

ah reads the file leniently: an entry missing what it needs is left out, and a
file that isn't JSON shows an error on the page, which keeps what it last drew.

## What's computed

- A project's status is "needs you" while a waiting item has its name, else
  "running" while one of its agents is working, else "idle".
- The In progress tab is every live agent ah knows of, except the one the
  page is bound to (you), working ones first.
- The page redraws when `home.json` or the prose file is saved, and asks for
  the agents every 5 seconds while it's in view.
