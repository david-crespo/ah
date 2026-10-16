import { expect, test } from "vitest"
import { GRACE_MS, Presence } from "../platform/presence.ts"
import { Notices, type Showing, startContext } from "./notices.ts"

const showing = (files: [string, boolean][] = [], dashboard = true): Showing => ({
  files: files.map(([path, open]) => ({ path, agent: "a", open })),
  dashboard,
})

test("a starting session is told every active tracker, the current one marked", () => {
  expect(startContext("/w/b.html", ["/w/a.html", "/w/b.html"])).toEqual(
    [
      "Active trackers in this workspace (`ah tracker ls`). The ah dashboard shows the current one, which is what a request that doesn't name a tracker refers to.",
      "- /w/a.html",
      "- /w/b.html (current)",
      "When picking up work, check the tracker it belongs to, and keep it updated.",
    ].join("\n"),
  )
  expect(startContext(null, [])).toBeNull()
})

test("nothing changed, nothing said", () => {
  const n = new Notices()
  n.start("a", "/w/t.html", showing([["/w/p.md", true]]))
  expect(n.since("a", "/w/t.html", showing([["/w/p.md", true]]))).toEqual([])
})

test("a change of current tracker is said once, with the last state", () => {
  const n = new Notices()
  n.start("a", "/w/t.html", showing())
  // Two clicks between prompts
  expect(n.since("a", "/w/u.html", showing())).toEqual([
    "ah: the dashboard now shows /w/u.html as this workspace's current tracker",
  ])
  expect(n.since("a", "/w/u.html", showing())).toEqual([])
  expect(n.since("a", null, showing())).toEqual([
    "ah: this workspace has no current tracker now",
  ])
})

test("a current tracker the agent set itself isn't news", () => {
  const n = new Notices()
  n.start("a", "/w/t.html", showing())
  n.madeCurrent("a", "/w/u.html")
  expect(n.since("a", "/w/u.html", showing())).toEqual([])
})

test("a view the agent opened is said to be closed once", () => {
  const n = new Notices()
  n.start("a", null, showing([["/w/p.md", true]]))
  const closed = showing([["/w/p.md", false]])
  expect(n.since("a", null, closed)).toEqual([
    "ah: no window shows /w/p.md, which you opened, any more",
  ])
  expect(n.since("a", null, closed)).toEqual([])
  // Opened again and closed again
  n.since("a", null, showing([["/w/p.md", true]]))
  expect(n.since("a", null, closed)).toHaveLength(1)
})

test("a view opened and closed within one turn is said to be closed", () => {
  const n = new Notices()
  n.start("a", null, showing())
  expect(n.since("a", null, showing([["/w/p.md", false]]))).toHaveLength(1)
})

test("views bound to other agents aren't this one's news", () => {
  const n = new Notices()
  n.start("a", null, showing())
  const other: Showing = {
    files: [{ path: "/w/p.md", agent: "b", open: false }],
    dashboard: true,
  }
  expect(n.since("a", null, other)).toEqual([])
})

test("the dashboard closing is said", () => {
  const n = new Notices()
  n.start("a", null, showing([], true))
  expect(n.since("a", null, showing([], false))).toEqual([
    "ah: the dashboard is closed now",
  ])
  expect(n.since("a", null, showing([], false))).toEqual([])
})

test("an agent with nothing told yet, as after a server restart, hears nothing", () => {
  const n = new Notices()
  expect(n.since("a", "/w/t.html", showing([["/w/p.md", false]], false))).toEqual([])
  expect(n.since("a", "/w/t.html", showing([["/w/p.md", false]], false))).toEqual([])
})

test("a window counts as open for a grace period after its last page goes", () => {
  const p = new Presence(0)
  // On its way
  expect(p.open(GRACE_MS - 1)).toBe(true)
  expect(p.open(GRACE_MS)).toBe(false)
  p.update(1, 10_000)
  expect(p.open(100_000)).toBe(true)
  // A reload
  p.update(0, 100_000)
  expect(p.open(100_000 + GRACE_MS - 1)).toBe(true)
  expect(p.open(100_000 + GRACE_MS)).toBe(false)
  // Opened again: the window gets the grace period to connect
  p.expect(200_000)
  expect(p.open(200_000 + GRACE_MS - 1)).toBe(true)
})
