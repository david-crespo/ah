import { expect, test } from "vitest"
import { hookEvent } from "./hook.ts"

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
