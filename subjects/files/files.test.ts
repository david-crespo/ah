import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { Address } from "../../core/model.ts"
import { type AgentDirectory, type Live, locationOf, OpenFiles, Pages } from "./files.ts"
import type { WebSocket } from "ws"
import { EventEmitter } from "node:events"

let dir: string
let files: OpenFiles<Live>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-files-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  files = new OpenFiles(7420, {
    kind: "markdown",
    kinds: {},
    attach: async () => ({ close() {} }),
  })
})
afterEach(async () => {
  for (const f of files.list()) files.close(f.id)
  delete process.env.XDG_STATE_HOME
  await rm(dir, { recursive: true })
})

async function md(name: string) {
  const path = join(dir, name)
  await writeFile(path, `# ${name}\n`)
  return path
}

test("opening a file again rebinds it instead of adding a second", async () => {
  const a = await md("a.md")
  const b = await md("b.md")
  const first = await files.open(a, { harness: "claude", socket: "/s/1.sock", token: "t1" })
  const sent: string[] = []
  first.pages.connect(
    { send: (m: string) => sent.push(m), on() {}, close() {} } as never,
    [],
  )
  await files.open(b, null)
  const again = await files.open(a, { harness: "codex", thread: "t1", pid: process.pid })
  expect(again).toBe(first)
  expect(again.binding.openedFrom).toEqual({
    harness: "codex",
    thread: "t1",
    pid: process.pid,
  })
  expect(files.list().map((f) => f.path)).toEqual([a, b])
  expect(sent.map((m) => JSON.parse(m))).toEqual([
    expect.objectContaining({
      type: "thread",
      agentConnected: true,
      replay: false,
    }),
  ])
})

test("two opens at once share one", async () => {
  const a = await md("a.md")
  const [x, y] = await Promise.all([files.open(a, null), files.ensure(a)])
  expect(x).toBe(y)
  expect(files.list().length).toEqual(1)
})

test("ensure opens a file but doesn't rebind an open one", async () => {
  const a = await md("a.md")
  await files.open(a, { harness: "claude", socket: "/s/1.sock" })
  expect((await files.ensure(a)).binding.openedFrom).toEqual({
    harness: "claude",
    socket: "/s/1.sock",
  })
  expect((await files.ensure(await md("b.md"))).binding.openedFrom).toEqual(null)
  expect(files.list().length).toEqual(2)
})

test("close removes only that file", async () => {
  const a = await files.open(await md("a.md"), null)
  const b = await files.open(await md("b.md"), null)
  expect(files.close(a.id)?.path).toEqual(a.path)
  expect(files.close(a.id)).toEqual(undefined)
  expect(files.get(b.id)).toBe(b)
})

test("a file bound to an agent goes wherever the directory says it is now", async () => {
  const addresses = new Map<string, Address>()
  let standIn: Address | null = null
  const directory: AgentDirectory = {
    agentId: (ref) => ref.block,
    bind: (agent, address) => {
      if (address) addresses.set(agent, address)
    },
    address: (agent) => addresses.get(agent) ?? null,
    standIn: () => standIn,
  }
  files = new OpenFiles(
    7420,
    { kind: "markdown", kinds: {}, attach: async () => ({ close() {} }) },
    {
      directory,
    },
  )
  const opened = { harness: "codex" as const, thread: "th1", pid: null }
  const agent = files.agentId({
    harness: "codex",
    session: "th1",
    block: "block:1",
    process: null,
  })
  const file = await files.open(await md("a.md"), opened, agent)
  expect(file.binding.agent).toEqual("block:1")
  expect(files.address(file.binding)).toEqual(opened)
  // Codex's /new
  addresses.set("block:1", { harness: "codex", thread: "th2", pid: null })
  expect(files.info(file).address).toEqual("codex th2")
  // The directory forgot it: back to the session that opened the file
  addresses.clear()
  expect(files.address(file.binding)).toEqual(opened)
  // The agent's gone (no ~/.claude/sessions/1.json): another in its tab
  addresses.set("block:1", { harness: "claude", socket: "/s/1.sock" })
  expect(files.address(file.binding)).toEqual({ harness: "claude", socket: "/s/1.sock" })
  standIn = { harness: "codex", thread: "th3", pid: null }
  expect(files.address(file.binding)).toEqual(standIn)
})

test("a page's location comes from its socket's query", () => {
  expect(locationOf(new URLSearchParams("in=dashboard"))).toEqual("dashboard")
  expect(locationOf(new URLSearchParams("in=elsewhere"))).toEqual("page")
  expect(locationOf(new URLSearchParams())).toEqual("page")
})

test("pages know where each connected one is, and stop counting a closed one", () => {
  const socket = () =>
    Object.assign(new EventEmitter(), { send() {} }) as unknown as WebSocket
  const pages = new Pages()
  const [a, b] = [socket(), socket()]
  pages.connect(a, [], "window")
  pages.connect(b, [], "dashboard")
  expect(pages.locations).toEqual(["window", "dashboard"])
  expect(pages.presence.count).toEqual(2)
  ;(a as unknown as EventEmitter).emit("close")
  expect(pages.locations).toEqual(["dashboard"])
  expect(pages.presence.count).toEqual(1)
})
