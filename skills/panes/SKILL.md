---
name: panes
description: "Open a terminal pane next to yourself in Rex (a dev server, a log tail, a TUI or preview) without taking the user's focus, read what's on its screen, wait for its command to exit, and close it when done. Use when the user asks to open, split, or show something in a pane beside the agent, or when a long-running process would be easier to watch in its own pane."
---

# Panes next to yourself in Rex

In Rex each pane is a block, and your own block's id is in `$REX_BLOCK`. If
it's unset you aren't running in Rex: say so rather than opening a window
some other way.

Split your own block:

```
rex split --block "$REX_BLOCK" --split above --ratio 35 --focus=false --cwd "$PWD" --label <name> -- <cmd…>
```

- `--block "$REX_BLOCK"`: without it Rex splits whichever block has focus,
  which may be in another tab.
- `--split right|left|above|below` places the new pane, and `--ratio N` gives
  it N% of your pane.
- `--focus=false` leaves focus where the user has it. Rex focuses the new pane
  by default.
- The pane closes when its command exits. Add `--keep-open` to leave it up so
  the user can read the output.
- `--label` names the pane in Rex's UI. Use something short, like the command
  name.

`rex split` prints the new block's id. Close the pane with
`rex block close <id>`. To find a pane you didn't open, `rex block inspect
"$REX_BLOCK"` gives your window, and `rex block ls --window <window>` lists
the blocks in it.

Prefer splitting your own pane over splitting the user's, so the rest of
their layout stays put.

## When to use a pane

A pane is for a process the user wants to see: a dev server, a watcher, a
log tail, a TUI. Your own builds, tests, and one-off commands still go
through your usual shell tool, which gives you their output and tells you
when they finish. Open a pane for that work only if the user asks to watch
it.

## Reading a pane

Once a pane is up, you can check on it without asking the user to paste its
output, e.g. to see whether the dev server you started recompiled cleanly
after an edit:

```
rex capture --block <id> --trim --unwrap
```

- Always pass `--block`. Without it `rex capture` reads `$REX_BLOCK`, which
  is your own pane.
- It prints the visible screen only, not scrollback, so it shows the last
  screenful of a log. `--unwrap` joins soft-wrapped lines.

To block until a pane's command exits, `rex wait --for 10m <id>` returns that
command's exit status. It works on `--keep-open` panes too, since it waits for
the command, not the pane. For long waits, run it as a background command so
you're told when it ends. For a markdown file, `ah app page open <file> --in
split` opens it in `glow` above you.

## Sandbox

`rex` talks to the Rex server over a Unix socket that the Claude Code sandbox
blocks. Run `rex` commands with the sandbox disabled, or have the user
exclude `rex *` from the sandbox. Either way each call still goes through
permission review: an excluded command runs outside the sandbox but isn't
approved by that. What not to do is add `rex split` to the permission allow
list, which would approve running any command outside the sandbox without
review. In Codex, request escalated permissions.
