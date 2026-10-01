import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import type { Snapshot, Tab } from "./ghostty.ts"
import { resolve, rootFinder, type RootOf, tabRoot } from "./workspace.ts"

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
    terminals: cwds.map((cwd, i) => ({ id: `${id}.${i}`, cwd })),
  }
}

test("tabRoot takes the majority over the focused terminal", () => {
  assertEquals(tabRoot(tab("t", ["/var/folders/x", "/r/a", "/r/a/src"]), rootOf), "/r/a")
  assertEquals(tabRoot(tab("t", ["/r/b", "/r/a", "/r/a"], 0), rootOf), "/r/a")
})

test("tabRoot breaks ties with the focused terminal", () => {
  assertEquals(tabRoot(tab("t", ["/r/a", "/r/b"], 1), rootOf), "/r/b")
  // focused terminal outside any workspace: first in order
  assertEquals(tabRoot(tab("t", ["/r/a", "/r/b", "/tmp"], 2), rootOf), "/r/a")
})

test("tabRoot is null when no terminal is in a workspace", () => {
  assertEquals(tabRoot(tab("t", ["/tmp", ""]), rootOf), null)
})

function snapshot(front: string, selected: Record<string, string>): Snapshot {
  return {
    front,
    windows: [
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

test("resolve groups tabs by workspace in window id then tab order", () => {
  const state = resolve(snapshot("w1", { w1: "b", w2: "c" }), rootOf, null)
  assertEquals(state.focused, "/r/b")
  assertEquals(
    state.workspaces.map((w) => [w.name, w.tabs.map((t) => t.id)]),
    [
      ["a", ["a", "a2"]],
      ["b", ["b"]],
      ["c", ["c"]],
    ],
  )
})

test("resolve follows the front window's selected tab", () => {
  assertEquals(resolve(snapshot("w2", { w1: "b", w2: "c" }), rootOf, null).focused, "/r/c")
})

test("resolve keeps the previous focus on a tab outside any workspace", () => {
  const s = snapshot("w1", { w1: "x", w2: "c" })
  assertEquals(resolve(s, rootOf, "/r/c").focused, "/r/c")
  // unless that workspace has no tabs left
  assertEquals(resolve(s, rootOf, "/r/gone").focused, null)
})

test("resolve disambiguates workspaces with the same basename", () => {
  const s: Snapshot = {
    front: "w",
    windows: [
      {
        id: "w",
        selectedTab: "a",
        tabs: [tab("a", ["/r/x/app"]), tab("b", ["/r/y/app"])],
      },
    ],
  }
  const nested: RootOf = (dir) => dir.match(/^\/r\/[^/]+\/[^/]+/)?.[0] ?? null
  assertEquals(
    resolve(s, nested, null).workspaces.map((w) => w.name),
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
