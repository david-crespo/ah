import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { InputError, parseActivity, parseBatch, parseRequest, ThreadLog } from "./events.ts"
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
const answer = (replyTo: string) =>
  parseRequest({ kind: "chat", text: "Yes, that one", replyTo }, threadKinds)
const activity = (phase: string, requests: string[]) =>
  parseActivity({ phase, requests, text: "An answer" })
const statuses = (log: ThreadLog) =>
  [...log.requests.values()].map((state) => state.status).join()

test("appends persist and reload as waiting requests", () =>
  withLog(async (log, path) => {
    await log.request(user())
    const r2 = await log.request(user())
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

test("work state is per request, and a finished request takes no more", () =>
  withLog(async (log) => {
    const r1 = (await log.request(user())).id
    const r2 = (await log.request(user())).id
    await log.activity(activity("done", [r1]))
    assert(log.requests.get(r1)?.status === "done")
    assert(log.requests.get(r2)?.status === "waiting")
    await rejects(() => log.activity(activity("start", [r1])), 409)
    await rejects(() => log.activity(activity("done", [r1])), 409)
  }))

test("progress starts work, and a reply on a request needs it started", () =>
  withLog(async (log) => {
    const r1 = (await log.request(user())).id
    await rejects(() => log.activity(activity("reply", [r1])), 409)
    await log.activity(activity("progress", [r1]))
    assert(log.requests.get(r1)?.status === "working")
    await log.activity(activity("reply", [r1]))
    // A start after progress, as `ah message respond <file> start` sends, is fine
    await log.activity(activity("start", [r1]))
    await log.activity(activity("error", [r1]))
    assert(log.requests.get(r1)?.status === "error")
  }))

test("a log with work ids from before they were dropped still loads", () =>
  withLog(async (_, path) => {
    const at = new Date().toISOString()
    const lines = [
      { type: "request", id: "r1", kind: "chat", args: {}, text: "hi", at },
      { type: "activity", id: "a1", phase: "start", requests: ["r1"], workId: "w-r1", at },
      { type: "activity", id: "a2", phase: "done", requests: ["r1"], workId: "w-r1", at },
    ]
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
    const loaded = await ThreadLog.open(path, "/draft.md")
    assert(loaded.entries.length === 3)
    assert(statuses(loaded) === "done", statuses(loaded))
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
    await loaded.activity(activity("start", [r1, r2]))
    await loaded.activity(activity("done", [r1, r2]))
    assert([...loaded.requests.values()].every((state) => state.status === "done"))
  }))

test("an answer that ends closes the question it answers, live and on reload", () =>
  withLog(async (log, path) => {
    const question = (await log.request(user())).id
    await log.activity(activity("needs-reply", [question]))
    const reply = (await log.request(answer(question))).id
    await log.activity(activity("done", [reply]))
    assert(statuses(log) === "done,done", statuses(log))
    // A log written before this rule, stuck with the question open, loads fixed
    assert(statuses(await ThreadLog.open(path, "/draft.md")) === "done,done")

    // The agent already took the question back up: the answer leaves it be
    const other = (await log.request(user())).id
    await log.activity(activity("needs-reply", [other]))
    const second = (await log.request(answer(other))).id
    await log.activity(activity("start", [other, second]))
    await log.activity(activity("error", [second]))
    assert(log.requests.get(other)?.status === "working")
  }))

test("asking again moves the open question to the answer", () =>
  withLog(async (log, path) => {
    const question = (await log.request(user())).id
    await log.activity(activity("needs-reply", [question]))
    const first = (await log.request(answer(question))).id
    await log.activity(activity("needs-reply", [first]))
    assert(statuses(log) === "done,needs-reply", statuses(log))
    // Asking again on both ids at once comes out the same, whatever their order
    const again = (await log.request(answer(first))).id
    await log.activity(activity("needs-reply", [again, first]))
    assert(statuses(log) === "done,done,needs-reply", statuses(log))
    const last = (await log.request(answer(again))).id
    await log.activity(activity("done", [last]))
    assert(statuses(log) === "done,done,done,done", statuses(log))
    assert(statuses(await ThreadLog.open(path, "/draft.md")) === statuses(log))
  }))

test("an answer's ending reaches every open question up the chain", () =>
  withLog(async (log) => {
    const question = (await log.request(user())).id
    await log.activity(activity("needs-reply", [question]))
    const first = (await log.request(answer(question))).id
    // The agent asks about the answer while working on the question again,
    // then asks about the question too
    await log.activity(activity("start", [question, first]))
    await log.activity(activity("needs-reply", [first]))
    await log.activity(activity("needs-reply", [question]))
    const second = (await log.request(answer(first))).id
    await log.activity(activity("error", [second]))
    assert(statuses(log) === "error,error,error", statuses(log))
  }))

test("a reply to a missing request or a cycle of replies loads without looping", () =>
  withLog(async (_, path) => {
    const at = new Date().toISOString()
    const lines = [
      { type: "request", id: "lost", kind: "chat", args: {}, replyTo: "missing" },
      { type: "request", id: "self", kind: "chat", args: {}, replyTo: "self" },
      { type: "request", id: "a", kind: "chat", args: {}, replyTo: "b" },
      { type: "request", id: "b", kind: "chat", args: {}, replyTo: "a" },
      { type: "activity", phase: "start", requests: ["lost", "self", "a", "b"] },
      { type: "activity", phase: "needs-reply", requests: ["b"] },
      { type: "activity", phase: "needs-reply", requests: ["self", "a"] },
      { type: "activity", phase: "done", requests: ["lost"] },
    ]
    const log = lines.map((line, i) => ({ id: `e${i}`, at, ...line }))
    await writeFile(path, log.map((line) => JSON.stringify(line)).join("\n"))
    const loaded = await ThreadLog.open(path, "/draft.md")
    // No request closes itself by answering, through any loop
    assert(statuses(loaded) === "done,needs-reply,needs-reply,done", statuses(loaded))
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

const batch = (action: string, requests: string[] = []) => parseBatch({ action, requests })

test("a batch holds requests until sent, and what's taken out of it is gone", () =>
  withLog(async (log, path) => {
    const before = await log.request(user())
    await rejects(() => log.batch(batch("send")), 409)
    await log.batch(batch("open"))
    const kept = await log.request(user())
    const removed = await log.request(user())
    assert(statuses(log) === "waiting,batched,batched")
    assert(log.undelivered().length === 1)
    await rejects(() => log.batch(batch("remove", [before.id])), 409)
    await log.batch(batch("remove", [removed.id]))
    assert(!log.entries.some((e) => e.id === removed.id))
    // Reloaded mid-batch, it's still open
    const reloaded = await ThreadLog.open(path, "/draft.md")
    assert(reloaded.batching && statuses(reloaded) === "waiting,batched")
    const sent = await log.batch(batch("send"))
    assert(sent.map((r) => r.id).join() === kept.id)
    assert(!log.batching && statuses(log) === "waiting,waiting")
  }))

test("discarding a batch drops its requests and closes it", () =>
  withLog(async (log, path) => {
    await log.batch(batch("open"))
    await log.request(user())
    assert((await log.batch(batch("discard"))).length === 0)
    const reloaded = await ThreadLog.open(path, "/draft.md")
    assert(!reloaded.batching && reloaded.entries.length === 0)
    await rejects(() => parseBatch({ action: "close" }), 400)
  }))
