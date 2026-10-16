import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import type { RexState, Tab } from "../../core/model.ts"
import { rootFinder, type RootOf, tabRoot } from "../../core/workspace.ts"
import { resolve } from "./workspace.ts"

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

// Roots are /r/<name>; anything else is outside a workspace
const rootOf: RootOf = (dir) => dir.match(/^\/r\/[^/]+/)?.[0] ?? null

function tab(id: string, cwds: string[], focused = 0): Tab {
  return {
    id,
    name: `tab ${id}`,
    focused: `${id}.${focused}`,
    blocks: cwds.map((cwd, i) => ({ id: `${id}.${i}`, cwd })),
  }
}

test("tabRoot takes the majority over the focused block", () => {
  assertEquals(tabRoot(tab("t", ["/var/folders/x", "/r/a", "/r/a/src"]), rootOf), "/r/a")
  assertEquals(tabRoot(tab("t", ["/r/b", "/r/a", "/r/a"], 0), rootOf), "/r/a")
})

test("tabRoot breaks ties with the focused block", () => {
  assertEquals(tabRoot(tab("t", ["/r/a", "/r/b"], 1), rootOf), "/r/b")
  // focused block outside any workspace: first in order
  assertEquals(tabRoot(tab("t", ["/r/a", "/r/b", "/tmp"], 2), rootOf), "/r/a")
})

test("tabRoot is null when no block is in a workspace", () => {
  assertEquals(tabRoot(tab("t", ["/tmp", ""]), rootOf), null)
})

function rex(front: string, selected: Record<string, string>): RexState {
  return {
    front,
    sessions: [
      {
        id: "w2",
        selectedTab: selected.w2,
        tabs: [tab("c", ["/r/c"]), tab("a2", ["/r/a"])],
      },
      {
        id: "w1",
        selectedTab: selected.w1,
        tabs: [tab("a", ["/r/a"]), tab("x", ["/tmp"]), tab("b", ["/r/b"])],
      },
    ],
  }
}

test("resolve lists tabs in workspaces in window id then tab order", () => {
  const state = resolve(rex("w1", { w1: "b", w2: "c" }), rootOf, null)
  assertEquals(state.focused, "b")
  assertEquals(
    state.tabs.map((t) => [t.id, t.name, t.session, t.root]),
    [
      ["a", "a", "w1", "/r/a"],
      ["b", "b", "w1", "/r/b"],
      ["c", "c", "w2", "/r/c"],
      // a second tab in the same workspace gets a number
      ["a2", "a 2", "w2", "/r/a"],
    ],
  )
})

test("resolve follows the front session's selected tab", () => {
  assertEquals(resolve(rex("w2", { w1: "b", w2: "c" }), rootOf, null).focused, "c")
})

test("resolve keeps the previous focus on a tab outside any workspace", () => {
  const s = rex("w1", { w1: "x", w2: "c" })
  assertEquals(resolve(s, rootOf, "c").focused, "c")
  // unless that tab is gone
  assertEquals(resolve(s, rootOf, "gone").focused, null)
})

test("resolve disambiguates workspaces with the same basename", () => {
  const s: RexState = {
    front: "w",
    sessions: [
      {
        id: "w",
        selectedTab: "a",
        tabs: [tab("a", ["/r/x/app"]), tab("b", ["/r/y/app"])],
      },
    ],
  }
  const nested: RootOf = (dir) => dir.match(/^\/r\/[^/]+\/[^/]+/)?.[0] ?? null
  assertEquals(
    resolve(s, nested, null).tabs.map((t) => t.name),
    ["x/app", "y/app"],
  )
})

test("rootFinder finds the nearest .jj ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-dashboard-"))
  try {
    mkdirSync(join(dir, "repo", ".jj"), { recursive: true })
    mkdirSync(join(dir, "repo", "src", "deep"), { recursive: true })
    const find = rootFinder()
    assertEquals(find(join(dir, "repo", "src", "deep")), join(dir, "repo"))
    assertEquals(find(join(dir, "repo")), join(dir, "repo"))
    assertEquals(find(dir), null)
    assertEquals(find(""), null)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
