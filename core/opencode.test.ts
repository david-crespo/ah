import { expect, test, vi } from "vitest"
import type { Proc } from "../platform/proc.ts"
import { apply, readUpdate } from "./opencode.ts"
import type { RegistryEvent } from "./registry.ts"

/** The process table, each process's cwd, and how often each was read */
const procs = vi.hoisted(() => ({
  table: [] as Proc[],
  cwds: new Map<number, string>(),
  reads: 0,
  cwdReads: 0,
}))
vi.mock("../platform/proc.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/proc.ts")>()),
  processTable: () => (procs.reads++, procs.table),
  processCwds: (pids: number[]) => (
    procs.cwdReads++,
    new Map([...procs.cwds].filter(([pid]) => pids.includes(pid)))
  ),
}))

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

test("a session an `opencode run` made in its directory is skipped, as a child is", async () => {
  const received: RegistryEvent[] = []
  const core = {
    receive: (e: RegistryEvent) => (received.push(e), null),
    retitle: () => {},
  }
  const known = new Map()
  const service = { url: "http://127.0.0.1:1", auth: "" }
  const created = (session: string, cwd: string) =>
    apply(service, core, known, { kind: "event", event: "SessionStart", session, cwd })
  // No `opencode run`, so no cwds to look up
  await created("ses_tui", "/repo")
  expect(procs.cwdReads).toBe(0)
  // An agent in /repo runs one
  procs.table = [{ pid: 7, ppid: 6, pgid: 6, args: "/h/.opencode/bin/opencode run fix it" }]
  procs.cwds.set(7, "/repo")
  await created("ses_run", "/repo")
  await apply(service, core, known, {
    kind: "event",
    event: "UserPromptSubmit",
    session: "ses_run",
    cwd: null,
  })
  // A TUI's, in another directory, meanwhile
  await created("ses_other", "/other")
  expect(received.map((e) => e.kind === "hook" && e.session)).toEqual([
    "ses_tui",
    "ses_other",
  ])
  // Once per session created, and per turn of a skipped one
  expect(procs.reads).toBe(4)
})

test("a session an `opencode run` made is followed once a TUI resumes it", async () => {
  const received: RegistryEvent[] = []
  const core = {
    receive: (e: RegistryEvent) => (received.push(e), null),
    retitle: () => {},
  }
  const known = new Map()
  const service = { url: "http://127.0.0.1:1", auth: "" }
  const send = (event: "SessionStart" | "UserPromptSubmit" | "Stop") =>
    apply(service, core, known, {
      kind: "event",
      event,
      session: "ses_run",
      cwd: event === "SessionStart" ? "/repo" : null,
    })
  procs.table = [{ pid: 7, ppid: 6, pgid: 6, args: "/h/.opencode/bin/opencode run fix it" }]
  procs.cwds.set(7, "/repo")
  await send("SessionStart")
  await send("UserPromptSubmit")
  // The run exits, which alone changes nothing
  procs.table = []
  await send("Stop")
  expect(received).toEqual([])
  // A turn with no run in the directory is a TUI's
  await send("UserPromptSubmit")
  await send("Stop")
  expect(received.map((e) => e.kind === "hook" && [e.event, e.cwd])).toEqual([
    ["UserPromptSubmit", "/repo"],
    ["Stop", "/repo"],
  ])
})
