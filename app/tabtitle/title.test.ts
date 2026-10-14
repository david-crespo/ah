import { expect, test } from "vitest"
import type { Registry, SessionRecord } from "../sessions/registry.ts"
import { tabTitle } from "./title.ts"

const session = (
  terminalId: string,
  label: string,
  more: Partial<SessionRecord> = {},
): SessionRecord => ({
  terminalId,
  harness: "claude",
  label,
  cwd: null,
  busy: false,
  promptSequence: 1,
  summary: null,
  summarySequence: 0,
  updatedAt: 0,
  ...more,
})

function registry(
  sessions: Record<string, SessionRecord>,
  visible: Record<string, string>,
  shellLabels: Record<string, string> = {},
): Registry {
  return {
    sessions: new Map(Object.entries(sessions)),
    visible: new Map(Object.entries(visible)),
    shellLabels: new Map(Object.entries(shellLabels)),
  }
}

test("label once per run of terminals sharing it, then each one's summary", () => {
  const r = registry(
    {
      a: session("t1", "ah", { busy: true, summary: "Port titles" }),
      b: session("t2", "ah", { summary: "Edit README" }),
      c: session("t3", "dotfiles"),
    },
    { t1: "a", t2: "b", t3: "c" },
  )
  expect(tabTitle(["t1", "t2", "t3"], r)).toBe("ah | Port titles | Edit README | dotfiles")
})

test("a session that moved to another terminal doesn't count where it was", () => {
  const r = registry({ a: session("t2", "ah", { summary: "x" }) }, { t1: "a", t2: "a" })
  expect(tabTitle(["t1"], r)).toBeUndefined()
  expect(tabTitle(["t2"], r)).toBe("ah | x")
})

test("with no sessions, the first shell label; with none of those, nothing", () => {
  const r = registry({}, {}, { t2: "repos", t3: "other" })
  expect(tabTitle(["t1", "t2", "t3"], r)).toBe("repos")
  expect(tabTitle(["t1"], r)).toBeUndefined()
})

test("a closed terminal's session drops out because the tab no longer lists it", () => {
  const r = registry(
    {
      a: session("t1", "ah", { summary: "mine" }),
      b: session("t2", "ah", { summary: "gone" }),
    },
    { t1: "a", t2: "b" },
  )
  expect(tabTitle(["t1"], r)).toBe("ah | mine")
})
