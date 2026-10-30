import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { WebSocket } from "ws"
import { GRACE_MS } from "../../platform/presence.ts"
import { pathOf } from "../id.ts"
import type { RequestKinds } from "../thread/events.ts"
import { Files, type Live, locationOf, Pages } from "./files.ts"
import { MemoryDirectory } from "./testing.ts"

const kinds: RequestKinds = { chat: { text: "required", render: (r) => r.text! } }

let dir: string
let directory: MemoryDirectory
let attached: string[]
let closed: string[]
const type = {
  kind: "markdown" as const,
  kinds,
  attach: async (path: string): Promise<Live> => {
    attached.push(path)
    return { close: () => closed.push(path) }
  },
}
let files: Files<Live>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-files-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  directory = new MemoryDirectory()
  attached = []
  closed = []
  files = new Files(7420, type, directory)
})
afterEach(async () => {
  vi.useRealTimers()
  delete process.env.XDG_STATE_HOME
  await rm(dir, { recursive: true })
})

async function md(name: string) {
  const path = join(dir, name)
  await writeFile(path, `# ${name}\n`)
  return path
}

/** A page's socket: what it was sent, and whether it was closed */
function socket() {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    sent: [] as string[],
    send(m: string) {
      ws.sent.push(m)
    },
    close() {
      ws.readyState = 3
      ws.emit("close")
    },
  })
  return ws as typeof ws & WebSocket
}

test("binding a file again moves it to the new agent", async () => {
  const a = await md("a.md")
  await files.bind(a, { harness: "claude", socket: "/s/1.sock" }, "block:1")
  const codex = { harness: "codex" as const, thread: "t1", pid: process.pid }
  const info = await files.bind(a, codex, "block:2")
  expect(files.binding(a)).toEqual("block:2")
  expect(directory.route(a)).toEqual({ address: codex, via: "agent" })
  expect(info).toMatchObject({ path: a, agent: "block:2", views: [] })
  // The URL names the file
  expect(pathOf(info.id)).toEqual(a)
  expect(info.url).toEqual(`/view/markdown/${info.id}/`)
})

test("showing a file leaves its binding alone", async () => {
  const a = await md("a.md")
  await files.bind(a, null, "block:1")
  expect(await files.show(a)).toMatchObject({ agent: "block:1" })
  expect(await files.show(join(dir, "gone.md"))).toEqual(null)
})

test("the first page brings up the live state, which stops a while after the last leaves", async () => {
  vi.useFakeTimers()
  const a = await md("a.md")
  const [one, two] = [socket(), socket()]
  await Promise.all([
    files.connect(a, one, "window", (_live, thread) => [thread.snapshot(true)]),
    files.connect(a, two, "dashboard", () => ["hi"]),
  ])
  expect(attached).toEqual([a])
  expect(JSON.parse(one.sent[0])).toMatchObject({ type: "thread", replay: true })
  expect(two.sent).toEqual(["hi"])
  expect(files.shown()).toEqual([a])
  one.close()
  two.close()
  expect(files.shown()).toEqual([])
  // A reload comes back in time
  vi.advanceTimersByTime(GRACE_MS / 2)
  const three = socket()
  await files.connect(a, three, "window", () => [])
  vi.advanceTimersByTime(GRACE_MS)
  expect(closed).toEqual([])
  expect(attached).toEqual([a])
  three.close()
  vi.advanceTimersByTime(GRACE_MS)
  await vi.waitFor(() => expect(closed).toEqual([a]))
})

test("closing a file hangs up its windows, but not the dashboard's", async () => {
  const a = await md("a.md")
  const [window, dashboard] = [socket(), socket()]
  await files.connect(a, window, "window", () => [])
  await files.connect(a, dashboard, "dashboard", () => [])
  expect(files.close(a)).toEqual(1)
  expect(window.sent.map((m) => JSON.parse(m))).toEqual([{ type: "closed" }])
  expect(window.readyState).toEqual(3)
  expect(dashboard.readyState).toEqual(1)
  expect(files.info(a).views).toEqual(["dashboard"])
  expect(files.close(join(dir, "b.md"))).toEqual(0)
})

test("a file's presence outlasts its pages, for the agent's notices", async () => {
  vi.useFakeTimers()
  const a = await md("a.md")
  const page = socket()
  await files.connect(a, page, "window", () => [])
  expect(files.presence()).toEqual([{ path: a, open: true }])
  page.close()
  vi.advanceTimersByTime(GRACE_MS)
  expect(files.presence()).toEqual([{ path: a, open: false }])
})

test("a held request tells the directory", async () => {
  const a = await md("a.md")
  directory.bindFile(a, "block:1")
  const thread = await files.thread(a)
  expect(await files.thread(a)).toBe(thread)
  await thread.request({ kind: "chat", text: "hi", args: {} })
  expect([...directory.held]).toEqual([a])
  // Not running: no Claude process has this socket, so it stays held
  directory.addresses.set("block:1", { harness: "claude", socket: join(dir, "none.sock") })
  await thread.refresh()
  expect([...directory.held]).toEqual([a])
})

test("held requests go out after a restart, to the agent there now", async () => {
  const a = await md("a.md")
  directory.bindFile(a, "block:1")
  await (await files.thread(a)).request({ kind: "chat", text: "hi", args: {} })

  const posts: string[] = []
  const inbox = join(dir, "inbox.sock")
  const server = createServer((conn) => {
    let text = ""
    conn.on("data", (chunk) => (text += chunk))
    conn.on("end", () => (posts.push(text), conn.end()))
  })
  await new Promise<void>((resolve) => server.listen(inbox, resolve))
  try {
    directory.addresses.set("block:1", { harness: "claude", socket: inbox })
    // A new server knows the file only from the directory's held paths
    const after = new Files(7420, type, directory)
    after.refresh([...directory.held])
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toContain("hi")
    await vi.waitFor(() => expect([...directory.held]).toEqual([]))
  } finally {
    server.close()
  }
})

test("a page's location comes from its socket's query", () => {
  expect(locationOf(new URLSearchParams("in=dashboard"))).toEqual("dashboard")
  expect(locationOf(new URLSearchParams("in=elsewhere"))).toEqual("page")
  expect(locationOf(new URLSearchParams())).toEqual("page")
})

test("pages know where each connected one is, and stop counting a closed one", () => {
  const pages = new Pages()
  const [a, b] = [socket(), socket()]
  pages.connect(a, [], "window")
  pages.connect(b, [], "dashboard")
  expect(pages.locations).toEqual(["window", "dashboard"])
  expect(pages.presence.count).toEqual(2)
  a.close()
  expect(pages.locations).toEqual(["dashboard"])
  expect(pages.presence.count).toEqual(1)
})
