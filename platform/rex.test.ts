import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import {
  type BlockInfo,
  findRex,
  parseView,
  type RexHealth,
  rexTrouble,
  toRexState,
} from "./rex.ts"

// session.view as Rex returned it, trimmed: a tab with a split, and a tab
// with a floating layer
const view = {
  revision: 224,
  session_id: "session:s",
  label: "brave-summit",
  active_window_id: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
  windows: [
    {
      window_id: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
      label: "Window e8f6a21e",
      active: true,
      focused_block_id: "block:b",
      layers: [
        {
          layer_id: "layer:1",
          kind: "tiled",
          blocks: [{ block_id: "block:a" }, { block_id: "block:b" }],
        },
      ],
    },
    {
      window_id: "window:w2",
      label: "fix the sort",
      focused_block_id: "block:c",
      layers: [
        { layer_id: "layer:2", kind: "tiled", blocks: [{ block_id: "block:c" }] },
        { layer_id: "layer:3", kind: "floating", blocks: [{ block_id: "block:d" }] },
      ],
    },
  ],
}

const blocks = new Map<string, BlockInfo>([
  ["block:a", { cwd: "/r/ah", title: "zsh", pid: null }],
  ["block:b", { cwd: "/r/ah", title: "ah", pid: null }],
  ["block:c", { cwd: "/r/console", title: "console", pid: null }],
])

test("a session's view becomes a window of tabs", () => {
  const parsed = parseView(view)
  expect(parsed).not.toBeNull()
  expect(toRexState(new Map([["session:s", parsed!]]), blocks, "session:s")).toEqual({
    front: "session:s",
    sessions: [
      {
        id: "session:s",
        selectedTab: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
        tabs: [
          {
            id: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
            // no label of its own, so the focused block's title
            name: "ah",
            focused: "block:b",
            blocks: [
              { id: "block:a", cwd: "/r/ah" },
              { id: "block:b", cwd: "/r/ah" },
            ],
          },
          {
            id: "window:w2",
            name: "fix the sort",
            focused: "block:c",
            blocks: [
              { id: "block:c", cwd: "/r/console" },
              // not read yet
              { id: "block:d", cwd: "" },
            ],
          },
        ],
      },
    ],
  })
})

test("front is null for a session that's gone", () => {
  expect(toRexState(new Map(), blocks, "session:s").front).toBeNull()
})

test("parseView rejects what isn't a view", () => {
  expect(parseView({ windows: "nope", active_window_id: null })).toBeNull()
  expect(parseView(null)).toBeNull()
})

/** An empty rex binary at `path`, making its directories */
function binary(path: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "")
  chmodSync(path, 0o755)
}

const versions = "Library/Application Support/com.superlogical.rex/RexServer/Versions"

test("findRex takes the newest installed version, numerically", () => {
  const home = mkdtempSync(join(tmpdir(), "ah-rex-"))
  for (const v of ["998", "1203", "1190"])
    binary(join(home, versions, v, "Rex Server.app/Contents/MacOS/rex"))
  // A version directory left half-removed
  mkdirSync(join(home, versions, "1300"))
  expect(findRex(home, join(home, "Applications"))).toBe(
    join(home, versions, "1203/Rex Server.app/Contents/MacOS/rex"),
  )
})

test("findRex falls back to the app bundle's helper", () => {
  const home = mkdtempSync(join(tmpdir(), "ah-rex-"))
  const apps = join(home, "Applications")
  binary(join(apps, "Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"))
  binary(join(apps, "Other.app/Contents/Helpers/x/Contents/MacOS/rex"))
  expect(findRex(home, apps)).toBe(
    join(apps, "Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"),
  )
  expect(findRex(join(home, "nobody"), join(home, "nowhere"))).toBeNull()
})

test("rexTrouble: an unrunnable rex, then a dropped stream; a failed call isn't", () => {
  const healthy: RexHealth = {
    binary: "rex",
    events: { connected: true, lastEventAt: 1, reconnects: 0 },
    lastCall: { at: 1, error: "no such session" },
    unrunnable: null,
  }
  expect(rexTrouble(healthy)).toBeNull()
  const dropped = { ...healthy, events: { ...healthy.events, connected: false } }
  expect(rexTrouble(dropped)).toBe("rex events isn't running")
  expect(rexTrouble({ ...dropped, unrunnable: "can't run rex: spawn rex ENOENT" })).toBe(
    "can't run rex: spawn rex ENOENT",
  )
})
