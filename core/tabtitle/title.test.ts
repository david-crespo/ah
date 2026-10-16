import { expect, test } from "vitest"
import { type AgentRecord, blockOf, type Registry } from "../registry.ts"
import { tabTitle } from "./title.ts"

const agent = (
  block: string,
  label: string,
  more: Partial<AgentRecord> = {},
): AgentRecord => ({
  home: { kind: "block", block },
  harness: "claude",
  session: `s-${block}`,
  label,
  cwd: null,
  busy: false,
  shown: true,
  promptSequence: 1,
  summary: null,
  summarySequence: 0,
  updatedAt: 0,
  ...more,
})

function registry(
  agents: AgentRecord[],
  shellLabels: Record<string, string> = {},
): Registry {
  return {
    agents: new Map(agents.map((a) => [blockOf(a)!, a])),
    trackers: new Map(),
    shellLabels: new Map(Object.entries(shellLabels)),
  }
}

test("label once per run of blocks sharing it, then each one's summary", () => {
  const r = registry([
    agent("t1", "ah", { busy: true, summary: "Port titles" }),
    agent("t2", "ah", { summary: "Edit README" }),
    agent("t3", "dotfiles"),
  ])
  expect(tabTitle(["t1", "t2", "t3"], r)).toBe("ah | Port titles | Edit README | dotfiles")
})

test("an agent its pane no longer shows doesn't count", () => {
  const r = registry([agent("t1", "ah", { summary: "x", shown: false })], { t1: "ah/app" })
  expect(tabTitle(["t1"], r)).toBe("ah/app")
})

test("with no agents, the first shell label; with none of those, nothing", () => {
  const r = registry([], { t2: "repos", t3: "other" })
  expect(tabTitle(["t1", "t2", "t3"], r)).toBe("repos")
  expect(tabTitle(["t1"], r)).toBeUndefined()
})

test("a closed block's agent drops out because the tab no longer lists it", () => {
  const r = registry([
    agent("t1", "ah", { summary: "mine" }),
    agent("t2", "ah", { summary: "gone" }),
  ])
  expect(tabTitle(["t1"], r)).toBe("ah | mine")
})
