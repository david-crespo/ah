import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { RexState, TrackerEntry } from "./model.ts"
import { emptyRegistry, type Registry } from "./registry.ts"
import { subjectOf, Trackers } from "./trackers.ts"

let dir: string
let registry: Registry
let rex: RexState
let trackers: Trackers
let changes: object[]

const TRACKER = `<script type="module" src="/view/html/task_list.js"></script>`
const DAY = 24 * 60 * 60 * 1000

/** A jj workspace under the temp dir */
const workspace = (name: string) => {
  const root = join(dir, name)
  mkdirSync(join(root, ".jj"), { recursive: true })
  return root
}

/** A task list in a workspace's notes, last changed `daysAgo` */
const note = (root: string, name: string, daysAgo = 0, html = TRACKER) => {
  const path = join(root, ".claude/notes", name, "index.html")
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, html)
  const at = new Date(Date.now() - daysAgo * DAY)
  utimesSync(path, at, at)
  return path
}

const tab = (id: string, cwd: string) => ({
  id,
  name: id,
  focused: `${id}-block`,
  blocks: [{ id: `${id}-block`, cwd }],
})

const paths = (entries: TrackerEntry[]) =>
  entries.map((e) => ("path" in e.subject ? e.subject.path : null))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-trackers-"))
  registry = emptyRegistry()
  rex = { front: null, sessions: [] }
  changes = []
  trackers = new Trackers({ registry, rex: () => rex, changed: (c) => changes.push(c) })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("tabs on one workspace share its current tracker", () => {
  const a = workspace("a")
  const b = workspace("b")
  rex.sessions = [
    {
      id: "s",
      selectedTab: null,
      tabs: [tab("t1", a), tab("t2", join(a, "src")), tab("t3", b)],
    },
  ]
  expect(trackers.workspaceOf("t2")).toBe(a)
  expect(trackers.workspaceOf("t3")).toBe(b)
  const first = note(a, "first-tracker", 1)
  const second = note(a, "second-tracker", 1)
  trackers.add(a, first, Date.now() - 1000)
  trackers.add(a, second)
  expect(trackers.currentPath(a)).toBe(second)
  expect(trackers.currentPath(b)).toBeNull()
  expect(trackers.get(a)).toEqual({
    current: { kind: "html", path: second },
    active: [
      { subject: { kind: "html", path: second }, lastOpen: expect.any(Number) },
      { subject: { kind: "html", path: first }, lastOpen: expect.any(Number) },
    ],
    parked: [],
  })
  expect(changes).toHaveLength(2)
})

test("the current tracker outlives the tabs that set it", () => {
  // Kept by workspace, so nothing about tabs closing can drop it
  const a = workspace("a")
  const path = note(a, "x-tracker")
  trackers.add(a, path)
  rex.sessions = []
  expect(trackers.currentPath(a)).toBe(path)
})

test("active trackers are listed by last use, a week unused is parked", () => {
  const a = workspace("a")
  const now = Date.now()
  const recent = note(a, "recent-tracker", 1)
  const old = note(a, "old-tracker", 30)
  const current = note(a, "current-tracker", 30)
  trackers.add(a, recent, now - 3 * DAY)
  trackers.add(a, old, now - 20 * DAY)
  trackers.add(a, current, now - 20 * DAY)
  const { active, parked } = trackers.get(a)
  // The current one isn't parked by age
  expect(paths(active)).toEqual([recent, current])
  expect(paths(parked)).toEqual([old])
  expect(trackers.statusOf(old)).toBe("parked")
  expect(trackers.statusOf(join(a, "not-one.html"))).toBeNull()
})

test("outside a jj workspace, the directory stands in for one", () => {
  const plain = join(dir, "plain")
  mkdirSync(plain)
  registry.agents.set("claude:x", {
    home: null,
    harness: "claude",
    session: "x",
    cwd: plain,
    label: "plain",
    busy: false,
    summary: null,
    shown: false,
    ended: false,
    promptSequence: 0,
    summarySequence: 0,
    updatedAt: 0,
  })
  expect(trackers.workspaceOf("claude:x")).toBe(plain)
  const file = join(plain, "notes.md")
  writeFileSync(file, "# notes")
  trackers.add(plain, file)
  expect(trackers.get(plain).current).toEqual({ kind: "markdown", path: file })
})

test("a file's subject goes by its extension", () => {
  expect(subjectOf(join(dir, "page.html")).kind).toBe("html")
  expect(subjectOf(join(dir, "x.md")).kind).toBe("markdown")
})

test("a finished tracker leaves the list, is listed as done, until it's set again", () => {
  const a = workspace("a")
  const path = note(a, "x-tracker")
  trackers.add(a, path)
  expect(trackers.setStatus(path, "done")).toBe(true)
  expect(trackers.get(a)).toEqual({ current: null, active: [], parked: [] })
  expect(paths(trackers.done(a))).toEqual([path])
  expect(trackers.statusOf(path)).toBe("done")

  trackers.add(a, path)
  expect(trackers.statusOf(path)).toBe("active")
  expect(trackers.currentPath(a)).toBe(path)
  expect(trackers.done(a)).toEqual([])
})

test("finishing the current tracker makes the one used before it current", () => {
  const a = workspace("a")
  const older = note(a, "older-tracker")
  const before = note(a, "before-tracker")
  const after = note(a, "after-tracker")
  trackers.add(a, older, Date.now() - 2000)
  trackers.add(a, before, Date.now() - 1000)
  trackers.add(a, after)
  trackers.setStatus(after, "done")
  expect(trackers.currentPath(a)).toBe(before)
})

test("finishing the last active one leaves none current", () => {
  const a = workspace("a")
  const path = note(a, "x-tracker")
  const stale = note(a, "stale-tracker", 10)
  trackers.add(a, stale, Date.now() - 10 * DAY)
  trackers.add(a, path)
  trackers.setStatus(path, "done")
  expect(trackers.currentPath(a)).toBeNull()
})

test("a parked tracker leaves the list, and resuming brings it back", () => {
  const a = workspace("a")
  const path = note(a, "x-tracker", 10)
  trackers.add(a, path, Date.now() - 10 * DAY)
  trackers.setStatus(path, "parked")
  expect(trackers.statusOf(path)).toBe("parked")
  expect(trackers.get(a)).toEqual({
    current: null,
    active: [],
    parked: [{ subject: { kind: "html", path }, lastOpen: expect.any(Number) }],
  })
  // Resuming counts as using it, so it isn't parked again by age
  trackers.setStatus(path, "active")
  expect(paths(trackers.get(a).active)).toEqual([path])
  expect(trackers.currentPath(a)).toBeNull()
})

test("a path that isn't a tracker has no status to set", () => {
  workspace("a")
  expect(trackers.setStatus(join(dir, "a/x.html"), "done")).toBe(false)
  expect(changes).toEqual([])
})

test("pruning forgets trackers whose files are gone, and empty workspaces", () => {
  const a = workspace("a")
  const b = workspace("b")
  const kept = note(a, "kept-tracker")
  const gone = note(a, "gone-tracker")
  const alone = note(b, "alone-tracker")
  trackers.add(a, kept)
  trackers.add(a, gone)
  trackers.add(b, alone)
  rmSync(gone)
  rmSync(b, { recursive: true })
  expect(trackers.currentPath(a)).toBeNull()
  expect(trackers.prune()).toBe(true)
  expect([...registry.trackers]).toEqual([
    [
      a,
      {
        current: null,
        trackers: [{ path: kept, status: "active", used: expect.any(Number) }],
      },
    ],
  ])
  expect(trackers.prune()).toBe(false)
})
