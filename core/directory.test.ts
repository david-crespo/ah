import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { type Address, fileSubject, type RexState } from "../model.ts"
import { apply, emptyRegistry, type Registry, type RegistryEvent } from "./registry.ts"
import { Directory, RELAYED } from "./directory.ts"

/** What the directory posted, and whether posts fail, as when the agent's
 * session is gone */
const inbox = vi.hoisted(() => ({
  posts: [] as { to: Address; text: string }[],
  down: false,
}))
vi.mock("../platform/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/session.ts")>()),
  postTo: async (to: Address, text: string) => {
    if (inbox.down) throw new Error("no session")
    inbox.posts.push({ to, text })
  },
}))

let dir: string
let registry: Registry
let rex: RexState | null
let directory: Directory
let now: number
beforeEach(() => {
  inbox.posts = []
  inbox.down = false
  dir = mkdtempSync(join(tmpdir(), "ah-directory-"))
  registry = emptyRegistry()
  rex = null
  now = 0
  directory = new Directory({ registry, rex: () => rex, save: () => {} })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Rex's tabs now, each with its blocks */
const show = (tabs: Record<string, string[]>) => {
  rex = {
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
  }
  directory.onRex(rex)
}

const start = (
  harness: "claude" | "codex",
  session: string,
  block = "block:1",
): Extract<RegistryEvent, { kind: "hook" }> => ({
  kind: "hook",
  event: "SessionStart",
  harness,
  session,
  block,
  process: null,
  label: "ah",
  cwd: "/r/ah",
})

/** An event as the core applies it, a second after the last */
const report = (
  event: Extract<RegistryEvent, { kind: "hook" }>,
  address: Address | null = null,
) => {
  const { agent } = apply(registry, event, (now += 1000))
  if (agent) directory.heard(agent, event.harness, address)
}

const claude = (pid: number) => ({ harness: "claude" as const, socket: `/s/${pid}.sock` })
const codex = (thread: string) => ({ harness: "codex", thread, pid: null })

test("a Codex agent is reached at whatever session it's in now", () => {
  report(start("codex", "th1"))
  directory.bind("block:1", { harness: "codex", thread: "th1", pid: 42 })
  expect(directory.address("block:1")).toEqual({ harness: "codex", thread: "th1", pid: 42 })
  // /new
  report(start("codex", "th2"))
  expect(directory.address("block:1")).toEqual(codex("th2"))
})

test("another harness in the pane drops the last one's address", () => {
  report(start("claude", "s1"), claude(1))
  report(start("codex", "th1"))
  expect(directory.address("block:1")).toEqual(codex("th1"))
  report(start("claude", "s2"))
  // Its hooks didn't say where it is
  expect(directory.address("block:1")).toEqual(null)
})

test("an agent with no record yet is reached where it said", () => {
  directory.bind("claude-9", claude(9))
  expect(directory.address("claude-9")).toEqual(claude(9))
  expect(directory.address("block:2")).toEqual(null)
})

test("a gone agent's stand-in is the live one in its tab that last did something", () => {
  show({ t1: ["block:1", "block:2", "block:3"], t2: ["block:4"] })
  // No ~/.claude/sessions/1.json, so not running
  report(start("claude", "s1", "block:1"), claude(1))
  report(start("codex", "th2", "block:2"))
  report(start("codex", "th3", "block:3"))
  report(start("codex", "th4", "block:4"))
  expect(directory.standIn("block:1")).toEqual(codex("th3"))
  // Its pane closes
  show({ t1: ["block:2", "block:3"], t2: ["block:4"] })
  expect(directory.standIn("block:1")).toEqual(codex("th3"))
  // Then the tab
  show({ t2: ["block:4"] })
  expect(directory.standIn("block:1")).toEqual(null)
})

test("a file's requests go to the agent it's bound to, or that agent's stand-in", () => {
  show({ t1: ["block:1", "block:2"] })
  report(start("claude", "s1", "block:1"), claude(1))
  report(start("codex", "th2", "block:2"))
  const path = join(dir, "notes.md")
  expect(directory.route(fileSubject(path))).toEqual(null)
  directory.bindSubject(fileSubject(path), "block:1")
  // block:1's socket isn't live, so the tab's other agent takes it
  expect(directory.route(fileSubject(path))).toEqual({ address: codex("th2"), via: "tab" })
})

test("with its agent's tab gone, a file's requests go to an agent in its workspace", () => {
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".jj"), { recursive: true })
  mkdirSync(join(repo, "notes"))
  const path = join(repo, "notes", "tracker.html")
  show({ t2: ["block:2"], t3: ["block:3"] })
  // block:1's pane, and with it its tab, closed long ago
  directory.bindSubject(fileSubject(path), "block:1")
  report({ ...start("codex", "th2", "block:2"), cwd: join(repo, "src") })
  // More recent, but in another directory
  report({ ...start("codex", "th3", "block:3"), cwd: join(dir, "other") })
  const th2 = codex("th2")
  expect(directory.route(fileSubject(path))).toEqual({ address: th2, via: "workspace" })
  // A file never bound goes there too
  expect(directory.route(fileSubject(join(repo, "notes", "draft.md")))).toEqual({
    address: th2,
    via: "workspace",
  })
  // But not one outside any workspace
  expect(directory.route(fileSubject(join(dir, "loose.md")))).toEqual(null)
})

test("an agent whose session ended isn't live", () => {
  show({ t1: ["block:1", "block:2", "block:9"] })
  report(start("codex", "th1", "block:1"))
  report(start("codex", "th2", "block:2"))
  // A Codex TUI that quit, in a pane still open
  report({ ...start("codex", "th2", "block:2"), event: "SessionEnd" })
  expect(directory.agentsNear("block:9")).toEqual(["block:1"])
  const subject = fileSubject(join(dir, "notes.md"))
  directory.bindSubject(subject, "block:2")
  expect(directory.route(subject)).toEqual({ address: codex("th1"), via: "tab" })
  expect(directory.reach("block:2")).toEqual(codex("th1"))
  report({ ...start("codex", "th1", "block:1"), event: "SessionEnd" })
  expect(directory.route(subject)).toEqual(null)
  expect(directory.reach("block:2")).toEqual(null)
})

test("a file's workspace has no live agent once theirs ended", () => {
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".jj"), { recursive: true })
  show({ t2: ["block:2"] })
  report({ ...start("codex", "th2", "block:2"), cwd: repo })
  report({ ...start("codex", "th2", "block:2"), cwd: repo, event: "SessionEnd" })
  expect(directory.route(fileSubject(join(repo, "tracker.html")))).toEqual(null)
})

const posted = () =>
  inbox.posts.map(({ to, text }) => [to, text.replace(`${RELAYED}\n\n`, "")])

test("a pane's message goes to the agent in its tab, or waits for one", async () => {
  show({ t1: ["block:1", "block:9"] })
  // No agent in the tab yet
  expect(await directory.send("block:9", "first")).toBe("held")
  expect(await directory.send("block:9", "second")).toBe("held")
  expect(inbox.posts).toEqual([])
  report(start("codex", "th1", "block:1"))
  await directory.flush()
  expect(posted()).toEqual([
    [codex("th1"), "first"],
    [codex("th1"), "second"],
  ])
  expect(inbox.posts[0].text.startsWith(RELAYED)).toBe(true)
  expect(registry.outbox.has("block:9")).toBe(false)
  expect(await directory.send("block:9", "third")).toBe("sent")
  expect(posted().at(-1)).toEqual([codex("th1"), "third"])
})

test("a message from an agent's own pane goes to that agent", async () => {
  // A tool the agent started, like a diff review, shares its pane
  show({ t1: ["block:1", "block:2"] })
  report(start("codex", "th1", "block:1"))
  report(start("codex", "th2", "block:2"))
  expect(directory.targetNear("block:1")).toBe("block:1")
  expect(await directory.send("block:1", "mine")).toBe("sent")
  expect(posted()).toEqual([[codex("th1"), "mine"]])
})

test("a message that can't be posted waits, behind the ones before it", async () => {
  show({ t1: ["block:1", "block:9"] })
  report(start("codex", "th1", "block:1"))
  inbox.down = true
  expect(await directory.send("block:9", "first")).toBe("held")
  inbox.down = false
  // An older message is still waiting, so this one goes after it
  expect(await directory.send("block:9", "second")).toBe("sent")
  expect(posted()).toEqual([
    [codex("th1"), "first"],
    [codex("th1"), "second"],
  ])
})
