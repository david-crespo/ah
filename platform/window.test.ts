import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { Proc } from "./proc.ts"

// Nothing opens or builds for real: commands succeed or fail as `fake.ok`
// says, and the package is at `fake.root`, with no app built unless a test
// builds one
const fake = vi.hoisted(() => ({ ok: false, root: "/nonexistent", procs: [] as Proc[] }))
vi.mock("./proc.ts", () => ({
  run: async () => ({ success: fake.ok, code: 1, stdout: "", stderr: "it failed" }),
  processTable: () => fake.procs,
}))
vi.mock("./focus.ts", () => ({ focusHere: async () => ({ take: true, front: null }) }))
vi.mock("./assets.ts", () => ({ assetPath: (path: string) => `${fake.root}/${path}` }))

const { showUrl, windowOf } = await import("./window.ts")

const options = { name: "x", badge: "X", color: "#000000" }

afterEach(() => {
  fake.ok = false
  fake.root = "/nonexistent"
  fake.procs = []
  delete process.env.XDG_STATE_HOME
})

test("a failed build of the window app rejects, for the caller to report", async () => {
  await expect(showUrl("window", "http://127.0.0.1:1/", options)).rejects.toThrow(
    "couldn't build the window app:\nit failed",
  )
})

test("a tab that fails to open rejects", async () => {
  await expect(showUrl("tab", "http://127.0.0.1:1/", options)).rejects.toThrow("it failed")
})

test("a new copy of the app removes the old ones no window runs from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-window-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  fake.root = join(dir, "package")
  fake.ok = true
  const binary = (app: string) => join(app, "Contents/MacOS/ah-webview")
  const make = (app: string, daysOld = 0) => {
    mkdirSync(dirname(binary(app)), { recursive: true })
    writeFileSync(binary(app), "")
    const time = Date.now() / 1000 - daysOld * 24 * 60 * 60
    utimesSync(binary(app), time, time)
  }
  try {
    make(join(fake.root, "webview/build/ah.app"))
    const windows = join(dir, "state/ah/windows")
    make(join(windows, "old.app"), 40)
    make(join(windows, "open.app"), 40)
    make(join(windows, "recent.app"), 5)
    fake.procs = [
      {
        pid: 0,
        ppid: 0,
        pgid: 0,
        args: `${binary(join(windows, "open.app"))} --url other`,
      },
    ]
    await showUrl("window", "http://127.0.0.1:1/", { ...options, name: "new" })
    expect(readdirSync(windows).sort()).toEqual(["new.app", "open.app", "recent.app"])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("a page's window is the newest one at its address that listens for questions", () => {
  const proc = (pid: number, args: string) => ({ pid, ppid: 0, pgid: 0, args })
  const app = "/x/ah.app/Contents/MacOS/ah-webview"
  fake.procs = [
    proc(
      1,
      `${app} --url http://127.0.0.1:7521/view/page/s-1/?in=window --badge S --socket /t/a.sock`,
    ),
    proc(
      2,
      `${app} --url http://127.0.0.1:7521/view/page/s-1/?in=window --badge S --socket /t/b.sock`,
    ),
    // From before windows listened
    proc(3, `${app} --url http://127.0.0.1:7521/view/page/s-1/?in=window --badge S`),
    // Another page, and the same page on another server
    proc(
      4,
      `${app} --url http://127.0.0.1:7521/view/page/s-2/?in=window --socket /t/c.sock`,
    ),
    proc(
      5,
      `${app} --url http://127.0.0.1:7531/view/page/s-1/?in=window --socket /t/d.sock`,
    ),
  ]
  const page = new URL("http://127.0.0.1:7521/view/page/s-1/")
  expect(windowOf(page)).toEqual({ pid: 2, socket: "/t/b.sock" })
  expect(windowOf(new URL("http://127.0.0.1:7521/view/page/s-3/"))).toBeNull()
})
