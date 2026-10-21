# ah

ah is the user's personal tooling first. It's built around their setup: Rex,
their Helix fork and its Steel config, and Claude Code. Config that plugs ah
into those tools (Helix keybindings and Steel commands, Rex bindings) lives in
their dotfiles (`~/repos/dotfiles`) for now. Later, a setup doc here will
carry all of it, so the repo is self-contained.

## The CLI

The CLI is mainly for agents: the user rarely runs it. Design commands,
output and help text for an agent reading them.

## Refactoring

ah has one user and the repo is private, so refactors don't need to preserve
compatibility. Rename URLs, CLI commands, file formats and APIs outright, and
update whatever uses the old names (skills, task lists in notes, hooks) in the
same change instead of leaving aliases or shims behind.
