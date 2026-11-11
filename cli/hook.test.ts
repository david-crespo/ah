import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { exportSession, hookEvent, shellEvent } from "./hook.ts"

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

test("hookEvent ignores a run nested in another agent session's shell", () => {
  const prompt = (session: string) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session })
  // `claude -p` from Claude: Claude sets its own CLAUDE_CODE_SESSION_ID in
  // its hooks' env, so only ah's AH_SESSION shows the outer one
  const inClaude = { CLAUDE_CODE_SESSION_ID: "inner", AH_SESSION: "outer" }
  expect(hookEvent(prompt("inner"), "claude", inClaude)).toBeNull()
  // `codex exec` from Claude, Codex or opencode
  expect(
    hookEvent(prompt("inner"), "codex", { CLAUDE_CODE_SESSION_ID: "outer" }),
  ).toBeNull()
  expect(hookEvent(prompt("inner"), "codex", { CODEX_THREAD_ID: "outer" })).toBeNull()
  expect(hookEvent(prompt("inner"), "codex", { OPENCODE_SESSION_ID: "outer" })).toBeNull()
  // `claude -p` from Codex or opencode
  expect(hookEvent(prompt("inner"), "claude", { CODEX_THREAD_ID: "outer" })).toBeNull()
  expect(hookEvent(prompt("inner"), "claude", { OPENCODE_SESSION_ID: "outer" })).toBeNull()
  // A top-level Claude's hooks never have AH_SESSION, which only its Bash
  // tool's commands get, and their CLAUDE_CODE_SESSION_ID is Claude's own,
  // so it isn't compared
  const top = { CLAUDE_CODE_SESSION_ID: "a", REX_BLOCK: "t1" }
  expect(hookEvent(prompt("b"), "claude", top)).toMatchObject({ session: "b", block: "t1" })
  // Nor is the session's own id
  expect(hookEvent(prompt("a"), "codex", { CODEX_THREAD_ID: "a" })).toMatchObject({
    session: "a",
  })
})

test("shellEvent reports the pane's own shell, not one an agent runs", () => {
  const pane = { REX_BLOCK: "t1", TERM_PROGRAM: "rex" }
  expect(shellEvent("~/r/ah", pane)).toEqual({
    kind: "shell",
    block: "t1",
    label: "~/r/ah",
  })
  expect(shellEvent("~/r/ah", {})).toBeNull()
  // An interactive zsh from an agent's Bash tool (`zsh -i -c 'cd docs'`) has
  // the agent's REX_BLOCK, and the session id its harness exports
  for (const id of [
    "AH_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
  ]) {
    expect(shellEvent("docs", { ...pane, [id]: "a" })).toBeNull()
  }
})

test("Claude's SessionStart exports its session to its Bash commands", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ah-hook-")), "env")
  exportSession("0b6f-9a", file)
  // After /clear, the newer line wins
  exportSession("c41e", file)
  // Not a line of shell to run
  exportSession("x; rm -rf ~", file)
  expect(readFileSync(file, "utf8")).toBe(
    "export AH_SESSION=0b6f-9a\nexport AH_SESSION=c41e\n",
  )
})
