import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { InputError, parseActivity, parseRequest, ThreadLog } from "./events.ts"
import { threadKinds } from "./kinds.ts"

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message)
}
async function rejects(fn: () => unknown | Promise<unknown>, status: number) {
  try {
    await fn()
  } catch (error) {
    assert(error instanceof InputError && error.status === status)
    return
  }
  throw new Error("Expected rejection")
}
async function withLog(fn: (log: ThreadLog, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ah-events-"))
  const path = join(dir, "log.jsonl")
  await writeFile(path, "")
  try {
    await fn(await ThreadLog.open(path, "/draft.md"), path)
  } finally {
    await rm(dir, { recursive: true })
  }
}
const user = () => parseRequest({ kind: "chat", text: "Why this wording?" }, threadKinds)
const activity = (phase: string, requests: string[], workId = "w1") =>
  parseActivity({ phase, requests, workId, text: "An answer" })

test("appends persist and reload as waiting requests", () =>
  withLog(async (log, path) => {
    await log.request(user())
    const r2 = await log.request(user())
    assert(log.entries.map((entry) => entry.seq).join() === "1,2")
    const loaded = await ThreadLog.open(path, "/draft.md")
    assert(loaded.entries.length === 2 && loaded.requests.get(r2.id)?.status === "waiting")
  }))

test("a corrupt line is skipped, and a partial last one doesn't swallow the next append", () =>
  withLog(async (log, path) => {
    await log.request(user())
    await appendFile(path, "null\n[1]\n")
    await log.request(user())
    // A crash mid-append
    await appendFile(path, '{"type":"requ')
    const loaded = await ThreadLog.open(path, "/draft.md")
    assert(loaded.entries.length === 2)
    const r3 = await loaded.request(user())
    const reloaded = await ThreadLog.open(path, "/draft.md")
    assert(reloaded.entries.at(-1)?.id === r3.id)
  }))

test("work state is explicit, per request, and rejects late replies from superseded work", () =>
  withLog(async (log) => {
    const r1 = (await log.request(user())).id
    const r2 = (await log.request(user())).id
    await rejects(() => log.activity(activity("done", [r1])), 409)
    await log.activity(activity("start", [r1]))
    await log.activity(activity("start", [r1], "w2"))
    await rejects(() => log.activity(activity("done", [r1])), 409)
    await log.activity(activity("done", [r1], "w2"))
    assert(log.requests.get(r1)?.status === "done")
    assert(log.requests.get(r2)?.status === "waiting")
    await rejects(() => log.activity(activity("start", [r1])), 409)
  }))

test("restart retains history and questions but does not restore a working spinner", () =>
  withLog(async (log, path) => {
    const r1 = (await log.request(user())).id
    const r2 = (await log.request(user())).id
    await log.activity(activity("start", [r1, r2]))
    await log.activity(activity("needs-reply", [r2]))
    const loaded = await ThreadLog.open(path, "/draft.md")
    assert(loaded.requests.get(r1)?.status === "interrupted")
    assert(loaded.requests.get(r2)?.status === "needs-reply")
    await loaded.activity(activity("start", [r1, r2], "resumed"))
    await loaded.activity(activity("done", [r1, r2], "resumed"))
    assert([...loaded.requests.values()].every((state) => state.status === "done"))
  }))

test("validates payloads and does not persist unknown activity targets", () =>
  withLog(async (log) => {
    await rejects(() => parseRequest({ kind: "comment", text: "hello" }, threadKinds), 400)
    await rejects(() => parseRequest({ kind: "chat", text: " " }, threadKinds), 400)
    await rejects(() => parseRequest({ kind: "go", args: { item: "1" } }, threadKinds), 400)
    await rejects(() => parseActivity({ phase: "done", requests: [] }), 400)
    const chat = parseRequest(
      { kind: "chat", text: "x", args: { selection: "y" } },
      threadKinds,
    )
    assert(chat.args.selection === undefined)
    await rejects(() => log.activity(activity("start", ["missing"])), 404)
    assert(log.entries.length === 0)
  }))
