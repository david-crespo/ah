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
const answer = (replyTo: string) =>
  parseRequest({ kind: "chat", text: "Yes, that one", replyTo }, threadKinds)
const activity = (phase: string, requests: string[], workId = "w1") =>
  parseActivity({ phase, requests, workId, text: "An answer" })
const statuses = (log: ThreadLog) =>
  [...log.requests.values()].map((state) => state.status).join()
/** Ends requests the way the CLI does: start, then the ending */
async function finish(log: ThreadLog, phase: string, requests: string[], workId: string) {
  await log.activity(activity("start", requests, workId))
  await log.activity(activity(phase, requests, workId))
}

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

test("an answer that ends closes the question it answers, live and on reload", () =>
  withLog(async (log, path) => {
    const question = (await log.request(user())).id
    await finish(log, "needs-reply", [question], "w1")
    const reply = (await log.request(answer(question))).id
    await finish(log, "done", [reply], "w2")
    assert(statuses(log) === "done,done", statuses(log))
    // A log written before this rule, stuck with the question open, loads fixed
    assert(statuses(await ThreadLog.open(path, "/draft.md")) === "done,done")

    // The agent already took the question back up: the answer leaves it be
    const other = (await log.request(user())).id
    await finish(log, "needs-reply", [other], "w3")
    const second = (await log.request(answer(other))).id
    await log.activity(activity("start", [other, second], "w4"))
    await log.activity(activity("error", [second], "w4"))
    assert(log.requests.get(other)?.status === "working")
  }))

test("asking again moves the open question to the answer", () =>
  withLog(async (log, path) => {
    const question = (await log.request(user())).id
    await finish(log, "needs-reply", [question], "w1")
    const first = (await log.request(answer(question))).id
    await finish(log, "needs-reply", [first], "w2")
    assert(statuses(log) === "done,needs-reply", statuses(log))
    // Asking again on both ids at once comes out the same, whatever their order
    const again = (await log.request(answer(first))).id
    await finish(log, "needs-reply", [again, first], "w3")
    assert(statuses(log) === "done,done,needs-reply", statuses(log))
    const last = (await log.request(answer(again))).id
    await finish(log, "done", [last], "w4")
    assert(statuses(log) === "done,done,done,done", statuses(log))
    assert(statuses(await ThreadLog.open(path, "/draft.md")) === statuses(log))
  }))

test("an answer's ending reaches every open question up the chain", () =>
  withLog(async (log) => {
    const question = (await log.request(user())).id
    await finish(log, "needs-reply", [question], "w1")
    const first = (await log.request(answer(question))).id
    // The agent asks about the answer while working on the question again,
    // then asks about the question too
    await log.activity(activity("start", [question, first], "w2"))
    await log.activity(activity("needs-reply", [first], "w2"))
    await log.activity(activity("needs-reply", [question], "w2"))
    const second = (await log.request(answer(first))).id
    await finish(log, "error", [second], "w3")
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
    const log = lines.map((line, i) => ({ id: `e${i}`, seq: i + 1, at, ...line }))
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
