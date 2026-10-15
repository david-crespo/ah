import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Snapshot } from "../../host/rex.ts"
import { emptyRegistry, type RegistryEvent } from "./registry.ts"
import { SessionsApp } from "./routes.ts"

let dir: string
let app: SessionsApp
beforeEach(() => {
  // Saves are debounced; keep them from landing after the dir is gone
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), "ah-sessions-"))
  app = new SessionsApp(emptyRegistry(), join(dir, "registry.json"))
  // A starting session's reply waits for Rex's first snapshot
  app.onSnapshot({ windows: [] } as unknown as Snapshot)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const start = (
  harness: "claude" | "codex",
  session: string,
  address?: unknown,
  terminal = "block:1",
): RegistryEvent & { address?: unknown } => ({
  kind: "hook",
  event: "SessionStart",
  harness,
  session,
  terminal,
  label: "ah",
  cwd: "/r/ah",
  address,
})

const report = (event: object) =>
  app.handle(
    new Request("http://ah/app/sessions/event", {
      method: "POST",
      body: JSON.stringify(event),
    }),
    "event",
  )

const claude = (pid: number) => ({
  harness: "claude" as const,
  socket: `/s/${pid}.sock`,
  token: `t${pid}`,
})

test("a Claude agent's address is the one its latest process reported", async () => {
  await report(start("claude", "s1"))
  expect(
    app.bind({ harness: "claude", session: "s1", terminal: "block:1" }, claude(1)),
  ).toEqual("block:1")
  expect(app.address("block:1")).toEqual(claude(1))
  // A restart in the pane: a new process, with its own socket
  await report(start("claude", "s2", claude(2)))
  expect(app.address("block:1")).toEqual(claude(2))
  // Kept apart from the logged event
  expect(readFileSync(join(dir, "registry-events.jsonl"), "utf8")).not.toContain("t2")
})

test("a Codex agent is reached at whatever session it's in now", async () => {
  await report(start("codex", "th1"))
  app.bind("block:1", { harness: "codex", thread: "th1", pid: 42 })
  expect(app.address("block:1")).toEqual({ harness: "codex", thread: "th1", pid: 42 })
  // /new
  await report(start("codex", "th2"))
  expect(app.address("block:1")).toEqual({ harness: "codex", thread: "th2", pid: null })
})

test("another harness in the pane drops the last one's address", async () => {
  await report(start("claude", "s1", claude(1)))
  await report(start("codex", "th1"))
  expect(app.address("block:1")).toEqual({ harness: "codex", thread: "th1", pid: null })
  await report(start("claude", "s2"))
  // Its hooks didn't say where it is
  expect(app.address("block:1")).toEqual(null)
})

test("an agent with no record yet is reached where it said", () => {
  app.bind("claude-9", claude(9))
  expect(app.address("claude-9")).toEqual(claude(9))
  expect(app.address("block:2")).toEqual(null)
})

const snapshot = (tabs: Record<string, string[]>) =>
  ({
    front: null,
    windows: [
      {
        id: "w",
        selectedTab: null,
        tabs: Object.entries(tabs).map(([id, terminals]) => ({
          id,
          name: id,
          focused: null,
          terminals: terminals.map((t) => ({ id: t, cwd: "/r/ah" })),
        })),
      },
    ],
  }) as Snapshot

test("a gone agent's stand-in is the live one in its tab that last did something", async () => {
  app.onSnapshot(snapshot({ t1: ["block:1", "block:2", "block:3"], t2: ["block:4"] }))
  // No ~/.claude/sessions/1.json, so not running
  await report(start("claude", "s1", claude(1), "block:1"))
  await report(start("codex", "th2", undefined, "block:2"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th3", undefined, "block:3"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th4", undefined, "block:4"))
  const th3 = { harness: "codex", thread: "th3", pid: null }
  expect(app.standIn("block:1")).toEqual(th3)
  // Its pane closes, and its record goes
  app.onSnapshot(snapshot({ t1: ["block:2", "block:3"], t2: ["block:4"] }))
  expect(app.standIn("block:1")).toEqual(th3)
  // Then the tab
  app.onSnapshot(snapshot({ t2: ["block:4"] }))
  expect(app.standIn("block:1")).toEqual(null)
})
