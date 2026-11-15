# Setup

## Prerequisites

`ah` runs on macOS and requires Node 24 or newer and either Claude Code, Codex, or OpenCode. The tools below are needed for particular features; you can skip those features or swap in your own tools.

| Dependency                                                           | Used for                                                                                     | Skipping or replacing it                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rex](https://www.superlogical.com/updates/public-testing-beginning) | Dashboard, tab titles, and finding agents in terminal tabs.                                  | Pages opened directly by an agent work without Rex. Supporting another terminal or multiplexer takes new integration code.                                                                                                                                                                                                         |
| Xcode Command Line Tools                                             | Native windows.                                                                              | Optional for docs and pages: `ah tool doc` and `ah tool page` take `--in tab` to open in a browser tab instead. The dashboard, stack pages, `ah tool tracker add` and a stack's diff and Body buttons always open windows.                                                                                                         |
| jj                                                                   | Dashboard workspace discovery and commit log, and stack pages.                               | File views work without it. The dashboard's log runs `jj log --template home`, so your jj config needs a `home` template alias; without one the log pane shows jj's error. Replacing jj with git requires reworking the dashboard's workspace and log queries.                                                                     |
| jj-spr, with stack files, as `jj spr`                                | Pushing from stack pages.                                                                    | Optional. Without it, a stack page shows jj spr's error and can't push.                                                                                                                                                                                                                                                            |
| [Helix with Steel](helix.md)                                         | The embedded Helix editor and its comment commands.                                          | Optional. `--no-editor` keeps the preview and commenting working, or you can switch the editor pane to the included CodeMirror or Neovim sample adapters; see [Helix](#helix) below.                                                                                                                                               |
| skepsis and jq                                                       | The ah-skepsis skill's diff review.                                                          | Optional. A stack page's diff buttons need neither: the server hosts skepsis, an npm dependency. The [ah-skepsis skill](../skills/ah-skepsis/SKILL.md) runs skepsis from your local checkout, whose path it needs, and its Send button pipes through jq. Another diff viewer can be connected by having it call `ah message send`. |
| An LLM CLI                                                           | Tab-title summaries for Claude Code and Codex, and drafts of a stack page's update messages. | Optional. Without it, tab titles fall back to the directory name. Easy to swap for another command ([Tab titles](#tab-titles)); OpenCode generates its own summaries.                                                                                                                                                              |

## Installation

Run `npm install` and put `ah.ts` on your `PATH` as `ah`. `ah.ts` has a `#!/usr/bin/env node` shebang so Node 24 can run it directly.

`ah` commands that need the `ah` server will start it if it isn't running, and so will the agent hooks below. The server listens on `127.0.0.1:7420`, and serves HTML pages on `127.0.0.1:7421`. It talks to Rex over Rex's socket, so it has to start outside any agent sandbox. In practice a hook starts it when the first agent session starts. An `ah` command in a sandbox that blocks localhost can't reach or start the server, and exits saying so. Use `ah server status`, `restart`, and `stop` to manage the server. To upgrade, pull and run `ah server restart`; [upgrading](upgrading.md) lists the changes that need more, which `ah doctor` checks for.

## Hooks

`ah` uses agent harness hooks to keep track of which agent is running in which Rex pane. Each hook runs `ah hook agent`, which reads the hook payload JSON from stdin.

| Harness     | Command                          | Events                                                                 |
| ----------- | -------------------------------- | ---------------------------------------------------------------------- |
| Claude Code | `ah hook agent --harness claude` | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`               |
| Codex       | `ah hook agent --harness codex`  | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`               |
| OpenCode    | none                             | the server follows the event stream from OpenCode's background service |

OpenCode needs no setup. In OpenCode 2, every TUI is a client of one background service that runs all the sessions. The server finds that service through the file OpenCode writes in `~/.local/state/opencode/`, and looks for it again whenever it stops.

For example, the `SessionStart` entry in Claude Code's settings:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "ah hook agent --harness claude" }] }]
```

Claude Code sessions that bypass permission prompts need [`crossSessionInbound: "accept"`](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) to receive `ah`'s messages without an approval prompt.

pi isn't in the table because it has no hook setup of its own here. The server takes pi events from `ah hook agent --harness pi`, which gives a pi session tab titles and a place in the dashboard, and `ah doctor` checks its skills in `~/.pi/agent/skills`. ah can't post into a pi session, so requests from a page bound to one wait for another agent.

Codex fires `SessionStart` on the first prompt rather than at launch, so a Codex session only shows up in `ah` once you've sent it a prompt.

## Skills

`skills/` contains agent-facing instructions for using the `ah` tools (`ah-doc`, `ah-page`, `ah-tracker`, `ah-stack`, `ah-home`, and `ah-skepsis`) and for opening panes with `rex split` (`ah-panes`). Copy them into your harness's skills directory. Claude Code also takes a symlink to each; Codex, OpenCode and pi skip links, so they need copies.

## Helix

The editor pane runs the `hx` on your `PATH`. Any Helix works, but sending comments from Helix and auto-reloading when the agent changes files on disk need the Steel fork; see [helix.md](helix.md) for more on that. To use the included CodeMirror or Neovim adapters instead, or no editor pane, see [Swapping out Helix](other-editors.md).

## Tab titles

The server sets each Rex tab's title to its directory name and a few words about what the tab's agent is working on, like `ah | Port tab titles`. If two agents are running in a tab, the title includes both summaries separated by `|`.

The summaries need an LLM CLI: without it, the tab title is just the directory name. The only other use is a stack page's draft of the message for commits that update open PRs, which is `ai -m neon` in [`views/stack/message.ts`](../views/stack/message.ts) and falls back to "Update". I use my own CLI, [`ai`](https://github.com/david-crespo/llm-cli). To use another one, like `claude -p`, change `summaryCommand` at the top of [`core/summary.ts`](../core/summary.ts). It receives the system prompt as an argument and a JSON payload on stdin, and prints the label on stdout as plain text, so any CLI works without structured output. OpenCode is an exception: `ah` just uses OpenCode's own session title, so no CLI is needed.

The hooks above trigger the title updates. On each `UserPromptSubmit` event, the server passes the CLI the session's first prompt, its most recent prompts, the agent's last reply, and the previous summary. The system prompt in `core/summary.ts` tells the model to keep the previous summary unless the work has changed. If a summary isn't generated, the server logs a `summary-skipped` line in `~/.local/state/ah/registry-events.jsonl` with the reason, like `ai not found` or `ai exited 1` followed by the CLI's error.

To show a custom label in the tab title instead of the directory name, have zsh run `ah hook shell <label>` on startup and in `chpwd`. Rex sets `REX_BLOCK` to identify the current pane, and subshells started by an agent inherit the agent pane's `REX_BLOCK`. An agent's shell can also pick up your zsh functions, `chpwd` included, so without a check every `cd` the agent ran would relabel its pane. Only interactive shells should run the hook. Here `$title` is whatever label your `.zshrc` computes:

```zsh
if [[ -o interactive && -n $REX_BLOCK ]] && (( $+commands[ah] )); then
  ah hook shell "$title" >/dev/null 2>&1 &!
fi
```
