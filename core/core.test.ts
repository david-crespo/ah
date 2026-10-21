import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { RexState } from "./model.ts"
import { emptyRegistry, type RegistryEvent } from "./registry.ts"
import { Core } from "./core.ts"

let dir: string
let core: Core
beforeEach(() => {
  // Saves are debounced; keep them from landing after the dir is gone
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), "ah-sessions-"))
  core = new Core(emptyRegistry(), join(dir, "registry.json"))
  // A starting session's reply waits for Rex's first RexState
  core.onRex({ sessions: [] } as unknown as RexState)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const start = (
  harness: "claude" | "codex",
  session: string,
  address?: unknown,
  block = "block:1",
): RegistryEvent & { address?: unknown } => ({
  kind: "hook",
  event: "SessionStart",
  harness,
  session,
  block,
  process: null,
  label: "ah",
  cwd: "/r/ah",
  address,
})

const report = (event: object) =>
  core.handle(
    new Request("http://ah/core/event", {
      method: "POST",
      body: JSON.stringify(event),
    }),
    "event",
  )

const claude = (pid: number) => ({ harness: "claude" as const, socket: `/s/${pid}.sock` })

test("a Claude agent's address is the one its latest process reported", async () => {
  await report(start("claude", "s1"))
  const agent = core.agentId({
    harness: "claude",
    session: "s1",
    block: "block:1",
    process: null,
  })
  expect(agent).toEqual("block:1")
  core.bind(agent!, claude(1))
  expect(core.address("block:1")).toEqual(claude(1))
  // A restart in the pane: a new process, with its own socket
  await report(start("claude", "s2", claude(2)))
  expect(core.address("block:1")).toEqual(claude(2))
  // Kept apart from the logged event
  expect(readFileSync(join(dir, "registry-events.jsonl"), "utf8")).not.toContain("t2")
})

test("a Codex agent is reached at whatever session it's in now", async () => {
  await report(start("codex", "th1"))
  core.bind("block:1", { harness: "codex", thread: "th1", pid: 42 })
  expect(core.address("block:1")).toEqual({ harness: "codex", thread: "th1", pid: 42 })
  // /new
  await report(start("codex", "th2"))
  expect(core.address("block:1")).toEqual({ harness: "codex", thread: "th2", pid: null })
})

test("another harness in the pane drops the last one's address", async () => {
  await report(start("claude", "s1", claude(1)))
  await report(start("codex", "th1"))
  expect(core.address("block:1")).toEqual({ harness: "codex", thread: "th1", pid: null })
  await report(start("claude", "s2"))
  // Its hooks didn't say where it is
  expect(core.address("block:1")).toEqual(null)
})

test("an agent with no record yet is reached where it said", () => {
  core.bind("claude-9", claude(9))
  expect(core.address("claude-9")).toEqual(claude(9))
  expect(core.address("block:2")).toEqual(null)
})

const rex = (tabs: Record<string, string[]>) =>
  ({
    front: null,
    sessions: [
      {
        id: "w",
        selectedTab: null,
        tabs: Object.entries(tabs).map(([id, blocks]) => ({
          id,
          name: id,
          focused: null,
          blocks: blocks.map((t) => ({ id: t, cwd: "/r/ah" })),
        })),
      },
    ],
  }) as RexState

test("a gone agent's stand-in is the live one in its tab that last did something", async () => {
  core.onRex(rex({ t1: ["block:1", "block:2", "block:3"], t2: ["block:4"] }))
  // No ~/.claude/sessions/1.json, so not running
  await report(start("claude", "s1", claude(1), "block:1"))
  await report(start("codex", "th2", undefined, "block:2"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th3", undefined, "block:3"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th4", undefined, "block:4"))
  const th3 = { harness: "codex", thread: "th3", pid: null }
  expect(core.standIn("block:1")).toEqual(th3)
  // Its pane closes, and its record goes
  core.onRex(rex({ t1: ["block:2", "block:3"], t2: ["block:4"] }))
  expect(core.standIn("block:1")).toEqual(th3)
  // Then the tab
  core.onRex(rex({ t2: ["block:4"] }))
  expect(core.standIn("block:1")).toEqual(null)
})

test("a file's requests go to the agent it's bound to, or that agent's stand-in", async () => {
  core.onRex(rex({ t1: ["block:1", "block:2"] }))
  await report(start("claude", "s1", claude(1), "block:1"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th2", undefined, "block:2"))
  const path = join(dir, "notes.md")
  expect(core.route(path)).toEqual(null)
  core.bindFile(path, "block:1")
  // block:1's socket isn't live, so the tab's other agent takes it
  expect(core.route(path)).toEqual({ harness: "codex", thread: "th2", pid: null })
  // A sender can name its own agent
  expect(core.route(path, "block:2")).toEqual({
    harness: "codex",
    thread: "th2",
    pid: null,
  })
})

test("bindings and held files outlast the server, while their files do", () => {
  const kept = join(dir, "kept.md")
  const gone = join(dir, "gone.md")
  writeFileSync(kept, "")
  writeFileSync(gone, "")
  core.bindFile(kept, "block:1")
  core.bindFile(gone, "block:1")
  core.hold(kept, true)
  core.hold(gone, true)
  vi.advanceTimersByTime(1000)
  rmSync(gone)
  const after = Core.load(join(dir, "registry.json"))
  expect(after.binding(kept)).toEqual("block:1")
  expect(after.binding(gone)).toEqual(null)
  expect(after.held).toEqual([kept])
})

test("a shell's agents are the live ones in its tab, in its layout order", async () => {
  core.onRex(rex({ t1: ["block:1", "block:2", "block:3", "block:9"], t2: ["block:4"] }))
  await report(start("codex", "th1", undefined, "block:1"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th2", undefined, "block:2"))
  vi.advanceTimersByTime(1000)
  // No ~/.claude/sessions/3.json, so not running
  await report(start("claude", "s3", claude(3), "block:3"))
  vi.advanceTimersByTime(1000)
  await report(start("codex", "th4", undefined, "block:4"))
  const near = async (block: string) =>
    await (
      await core.handle(
        new Request(`http://ah/core/agents-near?block=${block}`),
        "agents-near",
      )
    ).json()
  const agent = (id: string) => ({
    id,
    harness: "codex",
    label: "ah",
    summary: null,
    busy: false,
  })
  expect(await near("block:9")).toEqual([agent("block:1"), agent("block:2")])
  // A pane Rex doesn't know
  expect(await near("block:5")).toEqual([])
})

test("hooks tell the agent its trackers, then what changed", async () => {
  const root = join(dir, "w")
  mkdirSync(join(root, ".jj"), { recursive: true })
  const [a, b] = ["a.html", "b.html"].map((name) => {
    const path = join(root, name)
    writeFileSync(path, "")
    return path
  })
  core.trackers.add(root, a)
  core.trackers.add(root, b)
  // Outside Rex, so its workspace is its directory's
  const hook = (event: "SessionStart" | "UserPromptSubmit") =>
    report({
      ...start("claude", "s1", undefined, ""),
      event,
      process: "claude-1",
      cwd: root,
    })
  const context = async (res: Promise<Response>) =>
    ((await (await res).json()) as { context: string | null }).context
  const started = await context(hook("SessionStart"))
  expect(started).toContain(`- ${a}\n`)
  expect(started).toContain(`- ${b} (current)`)
  expect(await context(hook("UserPromptSubmit"))).toBeNull()
  // A click in the dashboard
  core.trackers.add(root, a)
  expect(await context(hook("UserPromptSubmit"))).toEqual(
    `ah: the dashboard now shows ${a} as this workspace's current tracker`,
  )
  expect(await context(hook("UserPromptSubmit"))).toBeNull()
})
