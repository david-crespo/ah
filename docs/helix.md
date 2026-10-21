# Helix setup

First of all, Helix is not tied to `ah` in any deep way. You can have your coding agent swap out Helix for whatever editor you prefer. My original prototype of the markdown editor used [CodeMirror](https://codemirror.net/) and it worked great. As you can see below, getting Helix to work the way I want is a pain, and it's hard for me to recommend doing so to anyone who isn't already in the tiny niche of people who build Helix from source in order to use the [Steel plugin system](https://github.com/helix-editor/helix/pull/8675) fork.

`ah` uses Helix in two places:

- The Helix pane in the markdown editor, which runs a real `hx` process in a pty next to the markdown preview. The pane isn't tied to Helix. [`views/markdown/editor.ts`](../views/markdown/editor.ts) describes what fills the pane, so you could swap the terminal for an editor that runs in the page, like CodeMirror. [`codemirror_backend.ts`](../views/markdown/codemirror_backend.ts) and [`codemirror_pane.ts`](../views/markdown/codemirror_pane.ts) are an example of that. I left its npm packages out of `package.json`, so you'll need to add the ones listed at the top of `codemirror_pane.ts`. [`terminal_editor.ts`](../views/markdown/terminal_editor.ts) describes what the terminal needs from the editor running in it. To use a different terminal editor, implement its server and page halves and pick them in `files.ts` and `client.ts`. [`neovim.ts`](../views/markdown/neovim.ts) and [`neovim_command.ts`](../views/markdown/neovim_command.ts) do this for Neovim as an example (only very lightly tested).
- Comments sent from Helix to an agent (`editors/helix/`). You select lines and write a comment in a box under them, and `ah` posts it to an agent running in the same Rex terminal tab.

Both need my Helix fork. The comment commands also need some Steel config to load `ah`'s commands and bind keys to them.

## The fork

My fork is [david-crespo/helix](https://github.com/david-crespo/helix). The [`auto-reload`](https://github.com/david-crespo/helix/tree/auto-reload) branch has the full build, which is upstream `master` with two branches merged in and my own commits on top:

- `steel-event-system` from [mattwparas/helix](https://github.com/mattwparas/helix) for Steel scripting, including the components API that draws the comment box.
- `search_position` from [useche/helix](https://github.com/useche/helix) to put a limit on the search match counter. `ah` doesn't need this.
- The `auto-reload` commits, which are a port of [helix-editor/helix#13963](https://github.com/helix-editor/helix/pull/13963). This polls for changes on disk and reloads unmodified buffers, and adds an option to three-way merge disk changes into modified buffers.

In the markdown editor, `ah` starts the Helix pane with a copy of your `~/.config/helix/config.toml` that has two sections added. `[editor.auto-save]` saves 650ms after you stop typing, so the preview keeps up. `[editor.auto-reload]` checks the file every 300ms, so the pane picks up the agent's edits. If your config already has one of those sections, `ah` uses yours and doesn't add its own. Helix outside the pane still uses your config as it is. Upstream Helix rejects the `[editor.auto-reload]` config section, so the Helix pane won't start without the fork. If you're using upstream Helix, open pages with `ah view open --no-editor` instead.

To debug a three-way merge that went wrong, check `~/.cache/helix/helix.log`. It logs a line for each merge with the sizes of the base, the buffer, and the file on disk. If a merge leaves conflicts, it also saves all three versions and the result under `~/.cache/helix/auto-reload-merges/<unix ms>-<file name>/`.

Build Helix with the `steel` feature, then generate the Steel modules like `helix/components.scm` that the config requires:

```sh
git clone --branch auto-reload https://github.com/david-crespo/helix ~/repos/helix
cd ~/repos/helix
cargo install --path helix-term --locked --features steel
cargo xtask steel
```

I have a `helix-update` skill in my dotfiles that rebases this stack onto new upstream tips and pushes it back to the fork.

## Comment commands

`editors/helix/` has two Steel modules:

- `ah.scm` defines the commands `:ah-comment` for the selected lines and `:ah-comment-file` for the whole file. They shell out to the `ah` CLI, which has to be on Helix's `PATH`.
- `comment-box.scm` draws the UI component: a text input under the selected lines with an optional list underneath. It doesn't know anything about `ah`.

Symlink the `editors/helix` directory into Helix's config directory (`~/.config/helix`), which is on Steel's module search path:

```sh
ln -sfn ~/repos/ah/editors/helix ~/.config/helix/ah
```

Helix only exposes commands that are exported by `~/.config/helix/helix.scm`, so you need to require the module in `helix.scm` and re-export the commands:

```scheme
(require "ah/ah.scm")

(provide ah-comment
         ah-comment-file)
```

Then bind keys in `~/.config/helix/init.scm`. Defining a `keymap` for `(global)` merges these into your existing bindings:

```scheme
(require "helix/keymaps.scm")

(keymap (global) (normal (L (c ":ah-comment") (f ":ah-comment-file"))))
```

Running `:config-reload` in Helix reruns both `helix.scm` and `init.scm`, so you can edit the modules without restarting Helix.

## Where a comment goes

When you submit a comment in Helix, `ah.scm` runs `ah message send` with the file, line numbers, and selected text. Where the comment goes depends on where Helix is running.

When you run Helix in a normal Rex terminal pane, `ah` formats the file and line context above the comment and sends it as a plain message to an agent in the same tab. As the comment box opens, `ah.scm` runs `ah workspace agents` to see what agents are running in the tab:

- If there is one agent, the comment box title shows its name, like `cli.ts:12 → ah (claude)`.
- If there are several agents, the comment box lists them under the text input. You can cycle through them with Tab and Shift-Tab. `ah.scm` passes the selected agent to `ah message send` via `--agent`, and `ah` remembers that choice as the default for that terminal pane on future comments.
- If no agent is running yet, `ah` queues the message and delivers it to the next agent that starts in the tab.

When Helix is running inside the markdown editor web page, it doesn't know which Rex pane it's in, because the `ah` server removes Rex's environment variables from everything it starts. Instead, `ah` attaches the comment to the markdown page's comment thread on the selected text or cursor line, just like a comment made on the rendered preview side. The comment shows up in the page's chat pane, and the agent replies there. A comment on the whole file (`:ah-comment-file`) goes straight into that chat pane as a regular message.
