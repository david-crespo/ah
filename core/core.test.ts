import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { type Address, fileSubject, type RexState } from "../model.ts"
import { emptyRegistry, type RegistryEvent } from "./registry.ts"
import { Core, RELAYED } from "./core.ts"
import { Upgrades } from "./upgrades.ts"

/** What `ah message send` posted, and whether posts fail, as when the agent's
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
let core: Core
beforeEach(() => {
  inbox.posts = []
  inbox.down = false
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

test("the event log keeps only the start of a prompt", async () => {
  await report(start("claude", "s1"))
  await report({
    ...start("claude", "s1"),
    event: "UserPromptSubmit",
    prompt: "x".repeat(5000),
  })
  const lines = readFileSync(join(dir, "registry-events.jsonl"), "utf8").trim().split("\n")
  expect(JSON.parse(lines.at(-1)!).prompt).toBe("x".repeat(300))
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
  expect(core.route(fileSubject(path))).toEqual(null)
  core.bindSubject(fileSubject(path), "block:1")
  const th2 = { harness: "codex", thread: "th2", pid: null }
  // block:1's socket isn't live, so the tab's other agent takes it
  expect(core.route(fileSubject(path))).toEqual({ address: th2, via: "tab" })
  // A sender can name its own agent
  expect(core.route(fileSubject(path), "block:2")).toEqual({ address: th2, via: "agent" })
})

test("with its agent's tab gone, a file's requests go to an agent in its workspace", async () => {
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".jj"), { recursive: true })
  mkdirSync(join(repo, "notes"))
  const path = join(repo, "notes", "tracker.html")
  core.onRex(rex({ t2: ["block:2"], t3: ["block:3"] }))
  // block:1's pane, and with it its tab, closed long ago
  core.bindSubject(fileSubject(path), "block:1")
  await report({ ...start("codex", "th2", undefined, "block:2"), cwd: join(repo, "src") })
  vi.advanceTimersByTime(1000)
  // More recent, but in another directory
  await report({ ...start("codex", "th3", undefined, "block:3"), cwd: join(dir, "other") })
  const th2 = { harness: "codex", thread: "th2", pid: null }
  expect(core.route(fileSubject(path))).toEqual({ address: th2, via: "workspace" })
  // A file never bound goes there too
  expect(core.route(fileSubject(join(repo, "notes", "draft.md")))).toEqual({
    address: th2,
    via: "workspace",
  })
  // But not one outside any workspace, or one a sender named the agent for
  expect(core.route(fileSubject(join(dir, "loose.md")))).toEqual(null)
  expect(core.route(fileSubject(path), "block:1")).toEqual(null)
})

test("bindings and held subjects outlast the server, while their files do", () => {
  const kept = fileSubject(join(dir, "kept.md"))
  const gone = fileSubject(join(dir, "gone.md"))
  writeFileSync(kept.path, "")
  writeFileSync(gone.path, "")
  for (const subject of [kept, gone]) {
    core.bindSubject(subject, "block:1")
    core.hold(subject, true)
  }
  vi.advanceTimersByTime(1000)
  rmSync(gone.path)
  const after = Core.load(join(dir, "registry.json"))
  expect(after.binding(kept)).toEqual("block:1")
  expect(after.binding(gone)).toEqual(null)
  expect(after.held).toEqual([kept])
})

test("a change still waiting to be saved is saved as the server exits", () => {
  const file = join(dir, "registry.json")
  const on = vi.spyOn(process, "on")
  const loaded = Core.load(file)
  const onExit = on.mock.calls.find(([event]) => event === "exit")?.[1] as () => void
  on.mockRestore()
  // Called here, not as this test's process exits
  process.off("exit", onExit)
  const subject = fileSubject(join(dir, "kept.md"))
  writeFileSync(subject.path, "")
  loaded.bindSubject(subject, "block:1")
  onExit()
  expect(readFileSync(file, "utf8")).toContain(subject.path)
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
    target: false,
  })
  expect(await near("block:9")).toEqual([agent("block:1"), agent("block:2")])
  // A pane Rex doesn't know
  expect(await near("block:5")).toEqual([])
})

test("a shell's pick is where its sends go while it's in the tab", async () => {
  core.onRex(rex({ t1: ["block:1", "block:2", "block:9"], t2: ["block:4"] }))
  await report(start("codex", "th1", undefined, "block:1"))
  await report(start("codex", "th2", undefined, "block:2"))
  await report(start("codex", "th4", undefined, "block:4"))
  const pick = async (agent: string) =>
    await core.handle(
      new Request("http://ah/core/pick", {
        method: "POST",
        body: JSON.stringify({ block: "block:9", agent }),
      }),
      "pick",
    )
  expect(core.targetNear("block:9")).toBe(null)
  expect((await pick("block:2")).status).toBe(200)
  expect(core.targetNear("block:9")).toBe("block:2")
  // Not in its tab
  expect((await pick("block:4")).status).toBe(409)
  expect(core.targetNear("block:9")).toBe("block:2")
  // The picked agent's pane closes: the one left is the target
  core.onRex(rex({ t1: ["block:1", "block:9"], t2: ["block:4"] }))
  expect(core.targetNear("block:9")).toBe("block:1")
  // The shell's pane closes: the pick goes
  core.onRex(rex({ t1: ["block:1"], t2: ["block:4"] }))
  vi.advanceTimersByTime(11_000)
  core.onRex(rex({ t1: ["block:1"], t2: ["block:4"] }))
  expect(core.registry.picks.has("block:9")).toBe(false)
})

const sendFrom = async (block: string | null, text: string, agent?: string) =>
  await core.handle(
    new Request("http://ah/core/send", {
      method: "POST",
      body: JSON.stringify({ block, agent, text }),
    }),
    "send",
  )
const posted = () =>
  inbox.posts.map(({ to, text }) => [to, text.replace(`${RELAYED}\n\n`, "")])
const codex = (thread: string) => ({ harness: "codex", thread, pid: null })

test("a pane's message goes to the agent in its tab, or waits for one", async () => {
  core.onRex(rex({ t1: ["block:1", "block:9"] }))
  // No agent in the tab yet
  expect(await (await sendFrom("block:9", "first")).json()).toEqual({ status: "held" })
  expect(await (await sendFrom("block:9", "second")).json()).toEqual({ status: "held" })
  expect(inbox.posts).toEqual([])
  await report(start("codex", "th1", undefined, "block:1"))
  await core.flush()
  expect(posted()).toEqual([
    [codex("th1"), "first"],
    [codex("th1"), "second"],
  ])
  expect(inbox.posts[0].text.startsWith(RELAYED)).toBe(true)
  expect(core.registry.outbox.has("block:9")).toBe(false)
  expect(await (await sendFrom("block:9", "third")).json()).toEqual({ status: "sent" })
  expect(posted().at(-1)).toEqual([codex("th1"), "third"])
})

test("a message from an agent's own pane goes to that agent", async () => {
  // A tool the agent started, like a diff review, shares its pane
  core.onRex(rex({ t1: ["block:1", "block:2"] }))
  await report(start("codex", "th1", undefined, "block:1"))
  await report(start("codex", "th2", undefined, "block:2"))
  expect(core.targetNear("block:1")).toBe("block:1")
  expect(await (await sendFrom("block:1", "mine")).json()).toEqual({ status: "sent" })
  expect(posted()).toEqual([[codex("th1"), "mine"]])
})

test("a message that can't be posted waits, behind the ones before it", async () => {
  core.onRex(rex({ t1: ["block:1", "block:9"] }))
  await report(start("codex", "th1", undefined, "block:1"))
  inbox.down = true
  expect(await (await sendFrom("block:9", "first")).json()).toEqual({ status: "held" })
  inbox.down = false
  // An older message is still waiting, so this one goes after it
  expect(await (await sendFrom("block:9", "second")).json()).toEqual({ status: "sent" })
  expect(posted()).toEqual([
    [codex("th1"), "first"],
    [codex("th1"), "second"],
  ])
})

test("a message names its agent, which becomes the pane's pick", async () => {
  core.onRex(rex({ t1: ["block:1", "block:2", "block:9"], t2: ["block:4"] }))
  await report(start("codex", "th1", undefined, "block:1"))
  await report(start("codex", "th2", undefined, "block:2"))
  await report(start("codex", "th4", undefined, "block:4"))
  // Several agents and no pick: it waits rather than guess
  expect(await (await sendFrom("block:9", "which?")).json()).toEqual({ status: "held" })
  expect((await sendFrom("block:9", "there", "block:4")).status).toBe(409)
  expect(await (await sendFrom("block:9", "to 2", "block:2")).json()).toEqual({
    status: "sent",
  })
  expect(core.targetNear("block:9")).toBe("block:2")
  expect(posted()).toEqual([
    [codex("th2"), "which?"],
    [codex("th2"), "to 2"],
  ])
  // Outside Rex, straight to the agent named, or nowhere
  expect(await (await sendFrom(null, "from a shell", "block:4")).json()).toEqual({
    status: "sent",
  })
  expect(posted().at(-1)).toEqual([codex("th4"), "from a shell"])
  expect((await sendFrom(null, "to nobody")).status).toBe(409)
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

test("a starting agent hears about old files in its workspace, wherever they are", async () => {
  // A secondary workspace whose tracker is a file of the default one, as
  // through a linked .claude/notes, and a page bound to an agent there
  const [main, second] = [join(dir, "main"), join(dir, "second")]
  for (const root of [main, second]) mkdirSync(join(root, ".jj"), { recursive: true })
  const [tracker, page, elsewhere] = ["tracker.html", "page.html", "elsewhere.html"].map(
    (name) => {
      const path = join(main, name)
      writeFileSync(path, "old")
      return path
    },
  )
  core.trackers.add(second, tracker)
  const upgrades = new Upgrades([{ what: "old", needs: (t) => t === "old", how: "" }])
  let problems = 0
  core.useUpgrades(upgrades, () => problems)
  upgrades.scan([page, elsewhere])
  const hook = (cwd: string, process: string) =>
    report({ ...start("claude", process, undefined, ""), process, cwd })
  await hook(second, "claude-2")
  core.bindSubject(fileSubject(page), "claude-2")
  const context = async (cwd: string, process: string) =>
    ((await (await hook(cwd, process)).json()) as { context: string | null }).context
  expect(await context(second, "claude-3")).toContain(
    "`ah doctor` finds 2 files in this workspace that use an old ah format. Run it",
  )
  expect(await context(main, "claude-4")).toContain("finds 3 files")
  writeFileSync(tracker, "new")
  writeFileSync(page, "new")
  problems = 1
  expect(await context(second, "claude-5")).toContain(
    "`ah doctor` finds 1 problem with how ah is set up. Run it",
  )
})

test("outside jj, a directory's old files are the ones under it", async () => {
  const [here, neighbor] = [join(dir, "plain"), join(dir, "plain-2")]
  const [page, nested, other] = [
    join(here, "page.html"),
    join(here, ".claude", "notes", "t.html"),
    join(neighbor, "page.html"),
  ]
  for (const path of [page, nested, other]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "old")
  }
  const upgrades = new Upgrades([{ what: "old", needs: (t) => t === "old", how: "" }])
  core.useUpgrades(upgrades, () => 0)
  upgrades.scan([page, nested, other])
  const paths = async (root: string) =>
    (
      (await (
        await core.handle(
          new Request(`http://ah/core/upgrades?root=${encodeURIComponent(root)}`),
          "upgrades",
        )
      ).json()) as { path: string }[]
    ).map((o) => o.path)
  expect(await paths(here)).toEqual([page, nested])
  expect(await paths(neighbor)).toEqual([other])
})
