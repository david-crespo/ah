import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { tabTitle } from "../tabtitle/title.ts"
import { abbreviatePath, hookEvent } from "./hook.ts"
import {
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
  terminal: string | null,
  more: Partial<RegistryEvent & { kind: "hook" }> = {},
): RegistryEvent => ({
  kind: "hook",
  event,
  harness: "claude",
  session,
  terminal,
  label: "ah",
  cwd: "/r/ah",
  ...more,
})

test("a prompt marks the session busy and asks for a summary with the prior one", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"), 1)
  expect(tabTitle(["t1"], r)).toBe("ah")
  const { terminals, summarize } = apply(
    r,
    hook("UserPromptSubmit", "a", "t1", { transcript: "/x.jsonl", prompt: "do it" }),
    2,
  )
  expect(terminals).toEqual(["t1"])
  expect(summarize).toEqual({
    session: "a",
    sequence: 1,
    transcript: "/x.jsonl",
    prompt: "do it",
    priorSummary: null,
  })
  expect(r.sessions.get("a")?.busy).toBe(true)
  expect(tabTitle(["t1"], r)).toBe("ah")
  expect(applySummary(r, "a", 1, "Port titles")).toBe("t1")
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")

  // The next prompt keeps showing the last summary until its own is written
  const next = apply(r, hook("UserPromptSubmit", "a", "t1", { transcript: "/x.jsonl" }))
  expect(next.summarize?.priorSummary).toBe("Port titles")
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")
})

test("Stop and SessionEnd go idle but leave the session shown", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  applySummary(r, "a", 1, "Port titles")
  apply(r, hook("Stop", "a", "t1"))
  apply(r, hook("SessionEnd", "a", "t1"))
  expect(r.sessions.get("a")?.busy).toBe(false)
  expect(tabTitle(["t1"], r)).toBe("ah | Port titles")
})

test("a slow summary for an older prompt doesn't replace a newer one", () => {
  const r = emptyRegistry()
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  apply(r, hook("UserPromptSubmit", "a", "t1"))
  expect(applySummary(r, "a", 2, "newer")).toBe("t1")
  expect(applySummary(r, "a", 1, "older")).toBeNull()
  expect(r.sessions.get("a")?.summary).toBe("newer")
})

test("a cd in the terminal drops its session; the shell label is the fallback", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", terminal: "t1", label: "ah" })
  apply(r, hook("SessionStart", "a", "t1"))
  applySummary(r, "a", 1, "x")
  expect(tabTitle(["t1"], r)).toBe("ah | x")
  apply(r, { kind: "shell", terminal: "t1", label: "ah/app" })
  expect(tabTitle(["t1"], r)).toBe("ah/app")
})

test("a hook with no terminal records the session but shows it nowhere", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", terminal: "t1", label: "console" })
  const { terminals } = apply(r, hook("SessionStart", "a", null, { label: "/tmp/x" }))
  expect(terminals).toEqual([])
  expect(r.sessions.get("a")?.terminalId).toBeNull()
  expect(tabTitle(["t1"], r)).toBe("console")
})

test("a session resumed in another terminal leaves the first one", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  const { terminals } = apply(r, hook("SessionStart", "a", "t2"))
  expect(terminals).toEqual(["t1", "t2"])
  expect(r.visible.has("t1")).toBe(false)
  expect(r.visible.get("t2")).toBe("a")
})

test("a session resumed in another tab without SessionStart takes that tab's label", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1", { harness: "codex", label: "llm-web" }))
  apply(r, hook("UserPromptSubmit", "a", "t2", { harness: "codex", label: "omicron" }))
  expect(tabTitle(["t2"], r)).toBe("omicron")
  // In the same terminal, the label stays the one it started with
  apply(r, hook("Stop", "a", "t2", { harness: "codex", label: "omicron/nexus" }))
  apply(r, hook("Stop", "a", null, { harness: "codex", label: "/tmp" }))
  expect(tabTitle(["t2"], r)).toBe("omicron")
})

test("a second session in a terminal takes it over", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  apply(r, hook("SessionStart", "b", "t1", { label: "console" }))
  expect(tabTitle(["t1"], r)).toBe("console")
})

test("prune drops old sessions and closed terminals, keeping recent ones", () => {
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "old", "t1"), 0)
  apply(r, hook("SessionStart", "new", "t2"), 8 * 24 * 3600_000)
  apply(r, { kind: "shell", terminal: "t3", label: "x" })
  apply(r, { kind: "shell", terminal: "t4", label: "y" })
  const now = 8 * 24 * 3600_000
  // Rex not running: only age counts
  expect(prune(r, null, new Set(), now)).toBe(true)
  expect([...r.sessions.keys()]).toEqual(["new"])
  expect([...r.visible.keys()]).toEqual(["t2"])
  expect(prune(r, new Set(["t2"]), new Set(["t4"]), now)).toBe(true)
  expect([...r.shellLabels.keys()]).toEqual(["t4"])
})

test("a session starting takes its terminal's shell label over the hook's", () => {
  const r = emptyRegistry()
  apply(r, { kind: "shell", terminal: "t1", label: "omicron" })
  apply(r, hook("SessionStart", "a", "t1", { label: "/r/omicron" }))
  apply(r, hook("SessionStart", "b", "t2", { label: "/r/console" }))
  expect(r.sessions.get("a")?.label).toBe("omicron")
  expect(r.sessions.get("b")?.label).toBe("/r/console")
})

test("saves and loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"))
  dirs.push(dir)
  const r = emptyRegistry()
  apply(r, hook("SessionStart", "a", "t1"))
  apply(r, { kind: "shell", terminal: "t2", label: "x" })
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
  stored.sessions.b = { label: "no other fields" }
  stored.sessions.c = { ...stored.sessions.a, harness: null }
  stored.visible.t2 = 7
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
    terminal: "t1",
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
  expect(hookEvent(start, "claude", {})).toMatchObject({ terminal: null, label: "/r/ah" })
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
