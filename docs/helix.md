# Helix setup

ah uses Helix in two places:

- The helix pane on a file's page (`views/markdown/helix.ts`): real `hx` in
  a pty, next to the markdown preview.
- Comments from Helix to an agent (`editors/helix/`): select lines, write a
  comment in a box under them, and ah posts it to an agent in the Rex tab.

Both need the user's Helix fork. The comments also need Steel config that
loads ah's commands and binds keys to them.

## The fork

The user's fork is
[david-crespo/helix](https://github.com/david-crespo/helix), and its
[`auto-reload`](https://github.com/david-crespo/helix/tree/auto-reload)
branch is the whole build: upstream `master` with two branches merged in,
plus the user's commits on top.

- `steel-event-system` from
  [mattwparas/helix](https://github.com/mattwparas/helix): Steel scripting,
  including the components API the comment box draws with.
- `search_position` from [useche/helix](https://github.com/useche/helix): a
  limit on the search match counter. ah doesn't need it.
- The `auto-reload` commits: a port of
  [helix-editor/helix#13963](https://github.com/helix-editor/helix/pull/13963),
  which polls for changes on disk and reloads unmodified buffers, plus an
  option to three-way merge disk changes into modified ones.

The page's helix pane turns on auto-save, so the preview follows the typing,
and auto-reload, so the pane picks up the agent's edits. Upstream Helix
rejects the `[editor.auto-reload]` section, so without the fork the pane
won't start; open pages with `ah view open --no-editor` instead.

Build with the `steel` feature, then generate the Steel modules that config
requires (`helix/components.scm` and the rest):

```sh
git clone --branch auto-reload https://github.com/david-crespo/helix ~/repos/helix
cd ~/repos/helix
cargo install --path helix-term --locked --features steel
cargo xtask steel
```

The `helix-update` skill in the dotfiles rebases the stack onto new upstream
tips and pushes it back to the fork.

## Comment commands

`editors/helix/` has two Steel modules:

- `ah.scm`: the commands, `:ah-comment` on the selected lines and
  `:ah-comment-file` on the whole file. They run the `ah` CLI, which has to
  be on helix's `PATH`.
- `comment-box.scm`: the box, a text input under the lines with an optional
  list under the text. It knows nothing of ah.

Link the directory into Helix's config directory, which is on Steel's
module search path:

```sh
ln -sfn ~/repos/ah/editors/helix ~/.config/helix/ah
```

Helix only offers the commands `helix.scm` provides, so `helix.scm` requires
the module and provides its commands again:

```scheme
(require "ah/ah.scm")

(provide ah-comment
         ah-comment-file)
```

Bind keys in `init.scm`. A `keymap` for `(global)` merges into the existing
bindings:

```scheme
(require "helix/keymaps.scm")

(keymap (global) (normal (L (c ":ah-comment") (f ":ah-comment-file"))))
```

`:config-reload` reruns both files, so changes to the modules show up without
restarting Helix.

## Where a comment goes

Helix sends the comment with `ah message send`, giving the file, the lines
and the selection. In a Rex pane, ah writes them out ahead of the comment
and sends it to an agent in the tab as a plain message. The box asks
`ah workspace agents` for the agents in its tab as it opens:

- One agent: the title names it (`cli.ts:12 → ah (claude)`).
- Several: they're listed under the text, starting on the pane's pick if it
  has one. Tab and shift-tab move. The selected agent goes as `--agent`,
  which ah remembers as the pane's pick for later comments.
- None: ah holds the message and sends it to the next agent in the tab.

In a markdown page's helix pane, which runs without the session's Rex
variables, ah puts the comment into the file's thread instead, on the
selection or the cursor's line, as one made on the rendered side would. The
page's conversation shows it, and the agent answers there. A comment on the
whole file is a message in the conversation.
