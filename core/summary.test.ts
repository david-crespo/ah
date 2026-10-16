import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { buildSummaryPayload, readTranscript, sanitizeTitle } from "./summary.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "summary-"))
  dirs.push(dir)
  const path = join(dir, "t.jsonl")
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"))
  return path
}

const codexUser = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
})

test("reads Claude user messages, short forms of commands, and skips the rest", async () => {
  const path = transcript([
    { type: "system", message: { content: "ignore" } },
    { type: "user", message: { content: "Implement tab titles for Codex" } },
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    {
      type: "user",
      message: {
        content: "<command-name>/review</command-name><command-args>42</command-args>",
      },
    },
    { type: "user", message: { content: "<bash-input>jj log</bash-input>" } },
    { type: "user", message: { content: "<system-reminder>x</system-reminder>" } },
  ])
  expect((await readTranscript(path)).userMessages).toEqual([
    "Implement tab titles for Codex",
    "/review 42",
    "$ jj log",
  ])
})

test("reads Codex user response items without event duplicates", async () => {
  const path = transcript([
    { type: "session_meta", payload: {} },
    { type: "event_msg", payload: { type: "user_message", message: "duplicate" } },
    codexUser("Implement tab titles for Codex"),
  ])
  expect((await readTranscript(path)).userMessages).toEqual([
    "Implement tab titles for Codex",
  ])
})

test("skips the AGENTS.md and environment context Codex starts a session with", async () => {
  const path = transcript([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n- Prefer jj over git\n</INSTRUCTIONS>",
          },
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
          },
        ],
      },
    },
    codexUser("test"),
  ])
  expect((await readTranscript(path)).userMessages).toEqual(["test"])
  expect(await buildSummaryPayload(path, null, "test")).toBeUndefined()
})

test("includes a hook prompt not yet in the transcript", async () => {
  const path = transcript([codexUser("Implement tab titles for Codex")])
  expect(
    await buildSummaryPayload(
      path,
      "tab titles",
      "Verify resume and split-pane behavior in the Codex CLI",
    ),
  ).toEqual({
    priorSummary: "tab titles",
    firstMessage: "Implement tab titles for Codex",
    recentMessages: [
      "Implement tab titles for Codex",
      "Verify resume and split-pane behavior in the Codex CLI",
    ],
    lastReply: "",
  })
})

test("a short task is enough to summarize", async () => {
  const path = transcript([codexUser("write a sonnet")])
  expect(await buildSummaryPayload(path, null, "yes")).toEqual({
    priorSummary: "",
    firstMessage: "write a sonnet",
    recentMessages: ["write a sonnet"],
    lastReply: "",
  })
})

test("the agent's last reply, without thinking or tool calls", async () => {
  const claude = transcript([
    { type: "user", message: { content: "Fix the flaky summary test" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Two options: 1. retry 2. fake timers. Which?" },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    },
  ])
  expect(await buildSummaryPayload(claude, "Flaky summary test", "do 2")).toEqual({
    priorSummary: "Flaky summary test",
    firstMessage: "Fix the flaky summary test",
    recentMessages: ["Fix the flaky summary test"],
    lastReply: "Two options: 1. retry 2. fake timers. Which?",
  })
  const codex = transcript([
    codexUser("write a sonnet"),
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "At dawn, the roofs grow rose" }],
      },
    },
  ])
  expect((await readTranscript(codex)).lastReply).toBe("At dawn, the roofs grow rose")
})

test("nothing to summarize when every message is short", async () => {
  const path = transcript([{ type: "user", message: { content: "hi" } }])
  expect(await buildSummaryPayload(path, null, "ok")).toBeUndefined()
})

test("sanitizeTitle", () => {
  expect(sanitizeTitle(" a\n\tb\x1b[0m ")).toBe("a b[0m")
})
