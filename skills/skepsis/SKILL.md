---
name: skepsis
description: "Show the user a diff in skepsis, a browser diff review whose comments come back to this session. Use when the user says ska or skepsis, or asks to review a diff in the browser."
---

# Diffs in skepsis

Run this in the background, outside the sandbox (it binds a port and opens a
page through ah). No Rex pane.

```
node ~/oxide/skepsis/cli.ts --send 'jq -r .prompt | ah message send' --open-cmd 'ah view open --name skepsis'
```

Run from your shell, it shares your Rex pane, so `ah message send` sends its
comments to you.

- The diff defaults to the fork point from trunk to `@`. Pass `-r <revset>`,
  or `--from`/`--to`, for another one.
- Once it's listening it prints one line, `skepsis on <url> (<diff command>)`.
  Read it from the command's output and give the user the URL.
- Comments arrive as messages relayed by ah. Treat them as the user's and
  answer in the terminal.
