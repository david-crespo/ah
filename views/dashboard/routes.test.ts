import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Core } from "../../core/core.ts"
import { GRACE_MS } from "../../platform/presence.ts"
import type { Problem } from "../../platform/install_check.ts"
import type { DocBackend } from "../doc/routes.ts"
import type { PageBackend } from "../page/routes.ts"
import { Dashboard } from "./routes.ts"

type Watcher = { root: string; onChange?: (html: string) => void; closed: boolean }

/** The jj watchers the dashboard has made: logs, with onChange, and
 * snapshots */
const made = vi.hoisted(() => [] as Watcher[])

vi.mock("./jj.ts", () => {
  class Fake {
    html = null
    closed = false
    root: string
    onChange?: (html: string) => void
    constructor(root: string, onChange?: (html: string) => void) {
      this.root = root
      this.onChange = onChange
      made.push(this)
    }
    close() {
      this.closed = true
    }
  }
  return { LogWatcher: Fake, SnapshotWatcher: Fake }
})

let root: string
let dashboard: Dashboard
let setupProblems: Problem[] = []

// One tab, in a workspace at `root`
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] })
  made.length = 0
  setupProblems = []
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-dashboard-")))
  mkdirSync(join(root, ".jj"))
  const core = {
    subscribe() {},
    trackers: { get: () => ({ current: null, active: [], parked: [] }) },
  } as unknown as Core
  dashboard = new Dashboard({
    core,
    doc: {} as DocBackend,
    page: {} as PageBackend,
    setupProblems: () => setupProblems,
  })
  dashboard.onRex({
    front: "s",
    sessions: [
      {
        id: "s",
        selectedTab: "t",
        tabs: [{ id: "t", name: "tab", focused: "b", blocks: [{ id: "b", cwd: root }] }],
        detached: [],
      },
    ],
  })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true })
})

const connect = async () =>
  (await dashboard.handle(new Request("http://ah/view/dashboard/events"), "events")).body!

const running = () =>
  made.filter((w) => !w.closed).map((w) => `${w.onChange ? "log" : "snapshot"} ${w.root}`)

test("the watchers run only while a page is open, and a moment after", async () => {
  expect(made).toEqual([])
  const page = await connect()
  expect(running()).toEqual([`log ${root}`, `snapshot ${root}`])
  await page.cancel()
  vi.advanceTimersByTime(GRACE_MS - 1)
  expect(running()).toHaveLength(2)
  vi.advanceTimersByTime(1)
  expect(running()).toEqual([])
})

test("a page back within the grace keeps the watchers", async () => {
  await (await connect()).cancel()
  vi.advanceTimersByTime(GRACE_MS - 1)
  const page = await connect()
  vi.advanceTimersByTime(GRACE_MS)
  expect(made).toHaveLength(2)
  expect(running()).toHaveLength(2)
  await page.cancel()
})

test("the first page gets the log once it's rendered", async () => {
  const reader = (await connect()).getReader()
  made.find((w) => w.onChange)!.onChange!("<pre>log</pre>")
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("event: jj")) text += decoder.decode((await reader.read()).value)
  expect(text).toContain(JSON.stringify({ root, html: "<pre>log</pre>" }))
  await reader.cancel()
})

test("a page hears what's wrong with ah's setup, and when that changes", async () => {
  const stale = { problem: "a copy differs", fix: "cp" }
  setupProblems = [stale]
  const reader = (await connect()).getReader()
  const decoder = new TextDecoder()
  const health = async () => {
    for (;;) {
      const text = decoder.decode((await reader.read()).value)
      const data = /event: health\ndata: (.*)/.exec(text)?.[1]
      if (data) return JSON.parse(data)
    }
  }
  expect(await health()).toEqual({ rex: null, setup: [stale] })
  setupProblems = []
  vi.advanceTimersByTime(15_000)
  expect(await health()).toEqual({ rex: null, setup: [] })
  await reader.cancel()
})
