import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import {
  type BlockInfo,
  findRex,
  Follower,
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

test("a tab's blocks are in layout order, top to bottom and left to right", () => {
  const leaf = (id: string) => ({ rect: [0, 0, 1, 1], block_id: id })
  const parsed = parseView({
    active_window_id: null,
    windows: [
      {
        window_id: "window:w",
        layers: [
          {
            layer_id: "layer:1",
            kind: "tiled",
            layout: {
              split: {
                direction: "horizontal",
                before: {
                  split: {
                    direction: "vertical",
                    before: leaf("block:a"),
                    after: leaf("block:b"),
                  },
                },
                after: leaf("block:c"),
              },
            },
            // Not the order they're laid out in
            blocks: [
              { block_id: "block:c" },
              { block_id: "block:b" },
              { block_id: "block:a" },
            ],
          },
          { layer_id: "layer:2", kind: "floating", blocks: [{ block_id: "block:d" }] },
        ],
      },
    ],
  })
  expect(parsed?.windows[0].blocks).toEqual(["block:a", "block:b", "block:c", "block:d"])
})

test("parseView rejects what isn't a view", () => {
  expect(parseView({ windows: "nope", active_window_id: null })).toBeNull()
  expect(parseView(null)).toBeNull()
})

/** A Rex server with these sessions' views, answering `rex api call` as
 * the real one does: an unknown session is an error */
function fakeRex(views: Map<string, unknown>) {
  return async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (method) {
      case "session.list":
        return { sessions: [...views.keys()].map((session_id) => ({ session_id })) }
      case "session.view": {
        const v = views.get(args.session_id as string)
        if (!v) throw new Error(`rex api call session.view: no session ${args.session_id}`)
        return v
      }
      case "block.method":
        return args.method === "process"
          ? { foreground: { pid: 7, cwd: `/r/${args.block_id}` } }
          : { title: `${args.block_id}` }
    }
    throw new Error(`no ${method}`)
  }
}

const tabsOf = (f: Follower) =>
  f.state().sessions.map((s) => s.tabs.map((t) => t.blocks.map((b) => b.id)))

test("the follower reads each session's view and its blocks, then follows events", async () => {
  const views = new Map<string, unknown>([["session:s", view]])
  let changes = 0
  const follower = new Follower(fakeRex(views), () => changes++)
  await follower.load()
  expect(tabsOf(follower)).toEqual([
    [
      ["block:a", "block:b"],
      ["block:c", "block:d"],
    ],
  ])
  expect(follower.blocks.get("block:c")).toEqual({
    cwd: "/r/block:c",
    title: "block:c",
    pid: 7,
  })
  // A cd in a block
  follower.onEvent({
    type: "session_event",
    payload: {
      session_id: "session:s",
      event: {
        type: "block_event",
        payload: {
          block_id: "block:c",
          name: "process_changed",
          payload: { foreground: { pid: 8, cwd: "/r/elsewhere" } },
        },
      },
    },
  })
  expect(follower.state().sessions[0].tabs[1].blocks[0]).toEqual({
    id: "block:c",
    cwd: "/r/elsewhere",
  })
  // The session goes
  follower.onEvent({ type: "session_destroyed", payload: { session_id: "session:s" } })
  expect(follower.state().sessions).toEqual([])
  expect(follower.blocks.size).toBe(0)
  expect(changes).toBe(3)
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
