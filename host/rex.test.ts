import { expect, test } from "vitest"
import { type BlockInfo, parseView, toSnapshot } from "./rex.ts"

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
  expect(toSnapshot(new Map([["session:s", parsed!]]), blocks, "session:s")).toEqual({
    front: "session:s",
    windows: [
      {
        id: "session:s",
        selectedTab: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
        tabs: [
          {
            id: "window:01a13ae4-6e65-77f3-96da-8d8ae8f6a21e",
            // no label of its own, so the focused terminal's title
            name: "ah",
            focused: "block:b",
            terminals: [
              { id: "block:a", cwd: "/r/ah" },
              { id: "block:b", cwd: "/r/ah" },
            ],
          },
          {
            id: "window:w2",
            name: "fix the sort",
            focused: "block:c",
            terminals: [
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
  expect(toSnapshot(new Map(), blocks, "session:s").front).toBeNull()
})

test("parseView rejects what isn't a view", () => {
  expect(parseView({ windows: "nope", active_window_id: null })).toBeNull()
  expect(parseView(null)).toBeNull()
})
