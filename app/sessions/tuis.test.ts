import { expect, test } from "vitest"
import type { Snapshot } from "../dashboard/ghostty.ts"
import { type Tui, focusedTerminal, isTui, pickTerminal, terminalFromEnv } from "./tuis.ts"

const bin =
  "/Users/x/.local/share/fnm/node-versions/v24/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"

test("isTui takes Codex's native binary's interactive runs only", () => {
  expect(isTui("codex", bin)).toBe(true)
  expect(isTui("codex", `${bin} --model o3`)).toBe(true)
  expect(isTui("codex", `${bin} resume 01a0fb02`)).toBe(true)
  expect(isTui("codex", `node /Users/x/.local/bin/codex`)).toBe(false)
  expect(isTui("codex", `${bin} app-server --listen unix:// --managed-daemon`)).toBe(false)
  expect(isTui("codex", `${bin} exec hi`)).toBe(false)
  expect(isTui("codex", `${bin} queue --thread t --message m`)).toBe(false)
  expect(isTui("codex", `${bin}-code-mode-host`)).toBe(false)
})

test("isTui takes opencode run bare or with flags", () => {
  expect(isTui("opencode", "opencode")).toBe(true)
  expect(isTui("opencode", "/Users/x/.opencode/bin/opencode --continue")).toBe(true)
  expect(isTui("opencode", "/Users/x/node_modules/@opencode/cli/bin/opencode.exe")).toBe(
    true,
  )
  expect(isTui("opencode", "/Users/x/.opencode/bin/opencode serve --service")).toBe(false)
  expect(isTui("opencode", "opencode run hi")).toBe(false)
  expect(isTui("opencode", `${bin}`)).toBe(false)
  expect(isTui("codex", "opencode")).toBe(false)
})

test("terminalFromEnv reads the id out of ps -E output", () => {
  const id = "E108697C-7BE2-4C03-A788-62AFD58A99F4"
  expect(terminalFromEnv(`15954 ${bin} TERM=xterm GHOSTTY_TERMINAL_ID=${id} HOME=/x`)).toBe(
    id,
  )
  expect(terminalFromEnv(`15954 ${bin} GHOSTTY_TERMINAL_ID=${id}`)).toBe(id)
  expect(terminalFromEnv(`15954 ${bin} XGHOSTTY_TERMINAL_ID=${id}`)).toBeNull()
  expect(terminalFromEnv(`15954 ${bin} TERM=xterm`)).toBeNull()
})

const tui = (terminal: string, cwd = "/repo"): Tui => ({ pid: 1, terminal, cwd })

test("pickTerminal keeps a session where it was while a TUI there fits", () => {
  const tuis = [tui("a"), tui("b")]
  expect(pickTerminal("/repo", tuis, "b", "a", null)).toBe("b")
})

test("pickTerminal takes the only TUI in the directory", () => {
  const tuis = [tui("a"), tui("b", "/other")]
  expect(pickTerminal("/repo", tuis, null, "b", null)).toBe("a")
  // The one it was in no longer runs a TUI there
  expect(pickTerminal("/repo", tuis, "gone", null, null)).toBe("a")
})

test("pickTerminal breaks a tie by focus, or leaves it open", () => {
  const tuis = [tui("a"), tui("b")]
  expect(pickTerminal("/repo", tuis, null, "b", null)).toBe("b")
  expect(pickTerminal("/repo", tuis, null, "c", null)).toBeNull()
  expect(pickTerminal("/repo", tuis, null, null, null)).toBeNull()
})

test("pickTerminal skips TUIs whose terminal isn't in the tree", () => {
  const tuis = [tui("a"), tui("stale")]
  expect(pickTerminal("/repo", tuis, null, null, new Set(["a"]))).toBe("a")
  expect(pickTerminal(null, tuis, null, null, null)).toBeNull()
})

test("focusedTerminal is the front window's selected tab's", () => {
  const snapshot: Snapshot = {
    front: "w2",
    windows: [
      {
        id: "w1",
        selectedTab: "t1",
        tabs: [{ id: "t1", name: "", focused: "x", terminals: [] }],
      },
      {
        id: "w2",
        selectedTab: "t3",
        tabs: [
          { id: "t2", name: "", focused: "y", terminals: [] },
          { id: "t3", name: "", focused: "z", terminals: [] },
        ],
      },
    ],
  }
  expect(focusedTerminal(snapshot)).toBe("z")
  expect(focusedTerminal(null)).toBeNull()
})
