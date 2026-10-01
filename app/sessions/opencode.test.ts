import { expect, test } from "vitest"
import { readUpdate } from "./opencode.ts"

const session = "ses_f034125d5ffe2ggwGaPUDfquc3"

test("readUpdate turns a session's lifecycle into registry events", () => {
  expect(
    readUpdate({
      type: "session.created",
      data: { sessionID: session, slug: "happy-knight", location: { directory: "/repo" } },
    }),
  ).toEqual({ kind: "event", event: "SessionStart", session, cwd: "/repo" })
  expect(
    readUpdate({ type: "session.execution.started", data: { sessionID: session } }),
  ).toEqual({ kind: "event", event: "UserPromptSubmit", session, cwd: null })
  for (const end of ["succeeded", "failed", "interrupted"]) {
    expect(
      readUpdate({ type: `session.execution.${end}`, data: { sessionID: session } }),
    ).toEqual({ kind: "event", event: "Stop", session, cwd: null })
  }
})

test("readUpdate takes titles, marks children, and skips the rest", () => {
  expect(
    readUpdate({
      type: "session.renamed",
      data: { sessionID: session, title: "Fix the bug" },
    }),
  ).toEqual({ kind: "title", session, title: "Fix the bug" })
  expect(
    readUpdate({
      type: "session.created",
      data: {
        sessionID: session,
        parentID: "ses_parent",
        location: { directory: "/repo" },
      },
    }),
  ).toEqual({ kind: "child", session })
  expect(
    readUpdate({ type: "session.text.delta", data: { sessionID: session } }),
  ).toBeNull()
  expect(readUpdate({ type: "server.connected", data: {} })).toBeNull()
  expect(readUpdate(null)).toBeNull()
})
