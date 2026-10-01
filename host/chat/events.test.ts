import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { ActivityLog, InputError, parseActivity, parseUser } from "./events.ts"

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
async function withLog(fn: (log: ActivityLog, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ah-events-"))
  const path = join(dir, "log.jsonl")
  await writeFile(path, "")
  try {
    await fn(await ActivityLog.open(path, "/draft.md"), path)
  } finally {
    await rm(dir, { recursive: true })
  }
}
const user = () => parseUser({ kind: "message", text: "Why this wording?" })
const activity = (phase: string, requestIds: string[], workId = "w1") =>
  parseActivity({ phase, requestIds, workId, text: "An answer" })

test("appends persist and reload as waiting requests", () =>
  withLog(async (log, path) => {
    await log.append(user())
    const r2 = await log.append(user())
    assert(log.events.map((event) => event.seq).join() === "1,2")
    const loaded = await ActivityLog.open(path, "/draft.md")
    assert(loaded.events.length === 2 && loaded.requests.get(r2.id)?.status === "waiting")
  }))

test("a corrupt line is skipped, and a partial last one doesn't swallow the next append", () =>
  withLog(async (log, path) => {
    await log.append(user())
    await appendFile(path, "null\n[1]\n")
    await log.append(user())
    // A crash mid-append
    await appendFile(path, '{"kind":"mess')
    const loaded = await ActivityLog.open(path, "/draft.md")
    assert(loaded.events.length === 2)
    const r3 = await loaded.append(user())
    const reloaded = await ActivityLog.open(path, "/draft.md")
    assert(reloaded.events.at(-1)?.id === r3.id)
  }))

test("work state is explicit, per request, and rejects late replies from superseded work", () =>
  withLog(async (log) => {
    const r1 = (await log.append(user())).id
    const r2 = (await log.append(user())).id
    await rejects(() => log.append(activity("done", [r1])), 409)
    await log.append(activity("start", [r1]))
    await log.append(activity("start", [r1], "w2"))
    await rejects(() => log.append(activity("done", [r1])), 409)
    await log.append(activity("done", [r1], "w2"))
    assert(log.requests.get(r1)?.status === "done")
    assert(log.requests.get(r2)?.status === "waiting")
    await rejects(() => log.append(activity("start", [r1])), 409)
  }))

test("restart retains history and questions but does not restore a working spinner", () =>
  withLog(async (log, path) => {
    const r1 = (await log.append(user())).id
    const r2 = (await log.append(user())).id
    await log.append(activity("start", [r1, r2]))
    await log.append(activity("needs-reply", [r2]))
    const loaded = await ActivityLog.open(path, "/draft.md")
    assert(loaded.requests.get(r1)?.status === "interrupted")
    assert(loaded.requests.get(r2)?.status === "needs-reply")
    await loaded.append(activity("start", [r1, r2], "resumed"))
    await loaded.append(activity("done", [r1, r2], "resumed"))
    assert([...loaded.requests.values()].every((state) => state.status === "done"))
  }))

test("validates payloads and does not persist unknown activity targets", () =>
  withLog(async (log) => {
    await rejects(() => parseUser({ kind: "comment", text: "hello" }), 400)
    await rejects(() => parseUser({ kind: "message", text: " " }), 400)
    await rejects(() => parseActivity({ phase: "done", requestIds: [] }), 400)
    assert(
      parseUser({ kind: "message", text: "x", selection: "y" }).selection === undefined,
    )
    await rejects(() => log.append(activity("start", ["missing"])), 404)
    assert(log.events.length === 0)
  }))
