import { expect, test } from "vitest"
import type { RexState } from "./model.ts"
import { type Tui, focusedBlock, isTui, pickBlock, tuisInBlocks } from "./tuis.ts"

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

const tui = (block: string, cwd = "/repo"): Tui => ({ pid: 1, block, cwd })

test("pickBlock keeps a session where it was while a TUI there fits", () => {
  const tuis = [tui("a"), tui("b")]
  expect(pickBlock("/repo", tuis, "b", "a", null)).toBe("b")
})

test("pickBlock takes the only TUI in the directory", () => {
  const tuis = [tui("a"), tui("b", "/other")]
  expect(pickBlock("/repo", tuis, null, "b", null)).toBe("a")
  // The one it was in no longer runs a TUI there
  expect(pickBlock("/repo", tuis, "gone", null, null)).toBe("a")
})

test("pickBlock breaks a tie by focus, or leaves it open", () => {
  const tuis = [tui("a"), tui("b")]
  expect(pickBlock("/repo", tuis, null, "b", null)).toBe("b")
  expect(pickBlock("/repo", tuis, null, "c", null)).toBeNull()
  expect(pickBlock("/repo", tuis, null, null, null)).toBeNull()
})

test("pickBlock skips TUIs whose block isn't in the tree", () => {
  const tuis = [tui("a"), tui("stale")]
  expect(pickBlock("/repo", tuis, null, null, new Set(["a"]))).toBe("a")
  expect(pickBlock(null, tuis, null, null, null)).toBeNull()
})

test("focusedBlock is the front session's selected tab's", () => {
  const rex: RexState = {
    front: "w2",
    sessions: [
      {
        id: "w1",
        selectedTab: "t1",
        tabs: [{ id: "t1", name: "", focused: "x", blocks: [] }],
      },
      {
        id: "w2",
        selectedTab: "t3",
        tabs: [
          { id: "t2", name: "", focused: "y", blocks: [] },
          { id: "t3", name: "", focused: "z", blocks: [] },
        ],
      },
    ],
  }
  expect(focusedBlock(rex)).toBe("z")
  expect(focusedBlock(null)).toBeNull()
})

test("tuisInBlocks finds a TUI's block by its process group", () => {
  const foreground = new Map([
    // Codex's npm wrapper leads the group its native TUI is in
    [40589, { block: "b1", cwd: "/r/ah" }],
    [40691, { block: "b2", cwd: "/r/console" }],
    [50000, { block: "b3", cwd: "" }],
  ])
  const procs = [
    { pid: 40890, ppid: 40589, pgid: 40589, args: bin },
    { pid: 40691, ppid: 86455, pgid: 40691, args: "opencode" },
    // in the background of a shell, or in a block whose cwd isn't known yet
    { pid: 41000, ppid: 1, pgid: 41000, args: bin },
    { pid: 50001, ppid: 50000, pgid: 50000, args: bin },
  ]
  expect(tuisInBlocks(procs, foreground)).toEqual([
    { pid: 40890, block: "b1", cwd: "/r/ah" },
    { pid: 40691, block: "b2", cwd: "/r/console" },
  ])
})
