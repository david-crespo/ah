import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { tabTitle } from "./tabtitle/title.ts"
import { abbreviatePath, hookEvent } from "./hook.ts"
import {
  agentId,
  apply,
  applySummary,
  emptyRegistry,
  loadRegistry,
  prune,
  type RegistryEvent,
  saveRegistry,
} from "./registry.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const hook = (
  event: (RegistryEvent & { kind: "hook" })["event"],
  session: string,
  block: string | null,
  more: Partial<RegistryEvent & { kind: "hook" }> = {},
): RegistryEvent => ({
  kind: "hook",
  event,
  harness: "claude",
  session,
  block,
  process: null,
  label: "ah",
  cwd: "/r/ah",
  ...more,
})

const summary = (
  r: ReturnType<typeof emptyRegistry>,
  agent: string,
  session: string,
  sequence: number,
  text: string,
) => applySummary(r, { agent, session, sequence }, text)

test("a prompt marks the agent busy and asks for a summary with the prior one", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"), 1)
  expect(tabTitle(["t1"], r)).toBe("ah")
  const { agent, blocks, summarize } = apply(
    r,
    hook("UserPromptSubmit", "a", "t1", { transcript: "/x.jsonl", prompt: "do it" }),
    2,
  )
  expect(agent).toBe("t1")
  expect(blocks).toEqual(["t1"])
  expect(summarize).toEqual({
    agent: "t1",
    session: "a",
    sequence: 1,
    transcript: "/x.jsonl",
    prompt: "do it",
    priorSummary: null,
  })
  expect(r.agents.get("t1")?.busy).toBe(true)
  expect(tabTitle(["t1"], r)).toBe("ah")
  expect(summary(r, "t1", "a", 1, "Port titles")).toBe("t1")
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")

  // The next prompt keeps showing the last summary until its own is written
  const next = apply(r, hook("UserPromptSubmit", "a", "t1", { transcript: "/x.jsonl" }))
  expect(next.summarize?.priorSummary).toBe("Port titles")
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")
})

test("Stop and SessionEnd go idle but leave the agent shown", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  summary(r, "t1", "a", 1, "Port titles")
  apply(r, hook("Stop", "a", "t1"))
  expect(r.agents.get("t1")?.ended).toBe(false)
  apply(r, hook("SessionEnd", "a", "t1"))
  expect(r.agents.get("t1")?.busy).toBe(false)
  expect(r.agents.get("t1")?.ended).toBe(true)
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")
})

test("an agent that ended drops out of the title while another in the tab runs", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  summary(r, "t1", "a", 1, "Port titles")
  apply(r, hook("UserPromptSubmit", "b", "t2"))
  summary(r, "t2", "b", 1, "Side question")
  apply(r, hook("SessionEnd", "b", "t2"))
  expect(tabTitle(["t1", "t2"], r)).toBe("ah | Port titles")

  // A new session in the same pane counts again
  apply(r, hook("SessionStart", "c", "t2"))
  expect(r.agents.get("t2")?.ended).toBe(false)
  summary(r, "t2", "c", 1, "Next")
  expect(tabTitle(["t1", "t2"], r)).toBe("ah | Port titles | Next")
})

test("a slow summary for an older prompt doesn't replace a newer one", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  expect(summary(r, "t1", "a", 2, "newer")).toBe("t1")
  expect(summary(r, "t1", "a", 1, "older")).toBeNull()
  expect(r.agents.get("t1")?.summary).toBe("newer")
})

test("a new session in the pane starts over", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  summary(r, "t1", "a", 1, "Port titles")
  apply(r, hook("SessionStart", "b", "t1"))
  expect(r.agents.get("t1")).toMatchObject({
    session: "b",
    summary: null,
    promptSequence: 0,
  })
  expect(tabTitle(["t1"], r)).toBe("ah")
  // The old session's summary, still being written, doesn't land
  expect(summary(r, "t1", "a", 2, "late")).toBeNull()
})

test("a cd in the block hides its agent; the shell label is the fallback", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", block: "t1", label: "ah" })
  apply(r, hook("SessionStart", "a", "t1"))
  summary(r, "t1", "a", 1, "x")
  expect(tabTitle(["t1"], r)).toBe("ah | x")
  apply(r, { kind: "shell", block: "t1", label: "ah/app" })
  expect(tabTitle(["t1"], r)).toBe("ah/app")
})

test("a hook with no block is keyed by its process and shows nowhere", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", block: "t1", label: "console" })
  const { agent, blocks } = apply(
    r,
    hook("SessionStart", "a", null, { label: "/tmp/x", process: "claude-7" }),
  )
  expect(agent).toBe("claude-7")
  expect(blocks).toEqual([])
  expect(r.agents.get("claude-7")?.home).toEqual({ kind: "process", process: "claude-7" })
  expect(tabTitle(["t1"], r)).toBe("console")
  // Without a process either, by its session
  expect(apply(r, hook("SessionStart", "b", null)).agent).toBe("claude:b")
})

test("an event with no block goes to the agent that has its session", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1", { harness: "codex" }))
  const { agent, blocks } = apply(r, hook("Stop", "a", null, { harness: "codex" }))
  expect(agent).toBe("t1")
  expect(blocks).toEqual(["t1"])
  expect(r.agents.get("t1")?.home).toEqual({ kind: "block", block: "t1" })
  expect(agentId(r, { harness: "claude", session: "a", block: null, process: null })).toBe(
    "claude:a",
  )
})

test("a session resumed in another block leaves the first one", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  const { blocks } = apply(r, hook("SessionStart", "a", "t2"))
  expect(blocks).toEqual(["t1", "t2"])
  expect(r.agents.get("t1")?.shown).toBe(false)
  expect(r.agents.get("t2")?.session).toBe("a")
})

test("a session resumed in another tab without SessionStart takes that tab's label", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1", { harness: "codex", label: "llm-web" }))
  apply(r, hook("UserPromptSubmit", "a", "t2", { harness: "codex", label: "omicron" }))
  expect(tabTitle(["t2"], r)).toBe("omicron")
  // In the same block, the label stays the one it started with
  apply(r, hook("Stop", "a", "t2", { harness: "codex", label: "omicron/nexus" }))
  apply(r, hook("Stop", "a", null, { harness: "codex", label: "/tmp" }))
  expect(tabTitle(["t2"], r)).toBe("omicron")
})

test("a second session in a block takes it over", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  apply(r, hook("SessionStart", "b", "t1", { label: "console" }))
  expect(tabTitle(["t1"], r)).toBe("console")
})

const live = (blocks: string[]) => new Set(blocks)

test("prune drops agents in closed panes and old ones outside Rex", () => {
  const week = 8 * 24 * 3600_000
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "idle", "t1"), 0)
  apply(r, hook("SessionStart", "old", null, { process: "claude-1" }), 0)
  apply(r, hook("SessionStart", "new", "t2"), week)
  apply(r, { kind: "shell", block: "t3", label: "x" })
  apply(r, { kind: "shell", block: "t4", label: "y" })
  // An idle agent stays while its pane does
  expect(prune(r, live(["t1", "t2", "t3", "t4"]), new Set(), week)).toBe(true)
  expect([...r.agents.keys()]).toEqual(["t1", "t2"])
  // Rex not running: only age counts
  expect(prune(r, null, new Set(), week)).toBe(true)
  expect([...r.agents.keys()]).toEqual(["t2"])
  expect(prune(r, live(["t2"]), new Set(["t4"]), week)).toBe(true)
  expect([...r.shellLabels.keys()]).toEqual(["t4"])
})

test("a session starting takes its block's shell label over the hook's", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", block: "t1", label: "omicron" })
  apply(r, hook("SessionStart", "a", "t1", { label: "/r/omicron" }))
  apply(r, hook("SessionStart", "b", "t2", { label: "/r/console" }))
  expect(r.agents.get("t1")?.label).toBe("omicron")
  expect(r.agents.get("t2")?.label).toBe("/r/console")
})

test("saves and loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"))
  dirs.push(dir)
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  apply(r, { kind: "shell", block: "t2", label: "x" })
  r.trackers.set("/r", {
    current: "/r/t.html",
    trackers: [{ path: "/r/t.html", status: "active", used: 1 }],
  })
  saveRegistry(r, join(dir, "s.json"))
  expect(loadRegistry(join(dir, "s.json"))).toEqual(r)
  expect(loadRegistry(join(dir, "missing.json"))).toBeNull()
})

test("loading drops entries that aren't the right shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"))
  dirs.push(dir)
  const file = join(dir, "s.json")
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  saveRegistry(r, file)
  const stored = JSON.parse(readFileSync(file, "utf8"))
  stored.agents.b = { label: "no other fields" }
  stored.agents.c = { ...stored.agents.t1, harness: null }
  stored.trackers = { "/r": { current: 7, trackers: [] } }
  stored.shellLabels = "not an object"
  writeFileSync(file, JSON.stringify(stored))
  expect(loadRegistry(file)).toEqual(r)
  writeFileSync(file, "[]")
  expect(loadRegistry(file)).toBeNull()
})

test("hookEvent reads the hook's JSON and the shell's env", () => {
  const env = { REX_BLOCK: "t1" }
  const input = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "a",
    cwd: "/r/ah",
    prompt: "hi",
    transcript_path: "/x.jsonl",
  })
  expect(hookEvent(input, "codex", env)).toEqual({
    kind: "hook",
    event: "UserPromptSubmit",
    harness: "codex",
    session: "a",
    block: "t1",
    process: null,
    label: "/r/ah",
    cwd: "/r/ah",
    prompt: "hi",
    transcript: "/x.jsonl",
  })
  const start = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "a",
    cwd: "/r/ah",
  })
  expect(hookEvent(start, "claude", {})).toMatchObject({ block: null, label: "/r/ah" })
  expect(
    hookEvent('{"hook_event_name":"PreToolUse","session_id":"a"}', "claude", {}),
  ).toBeNull()
  expect(hookEvent("not json", "claude", {})).toBeNull()
})

test("abbreviatePath", () => {
  expect(abbreviatePath("/h/repos/ah", "/h")).toBe("ah")
  expect(abbreviatePath("/h/oxide/omicron/nexus", "/h")).toBe("omicron/nexus")
  expect(abbreviatePath("/h", "/h")).toBe("~")
  expect(abbreviatePath("/h/notes", "/h")).toBe("~/notes")
  expect(abbreviatePath("/tmp", "/h")).toBe("/tmp")
})
