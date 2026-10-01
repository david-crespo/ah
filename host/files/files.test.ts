import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { type Live, OpenFiles } from "./files.ts"

let dir: string
let files: OpenFiles<Live>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-files-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  files = new OpenFiles(7420, { name: "test", attach: async () => ({ close() {} }) })
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
  expect(again.session).toEqual({ harness: "codex", thread: "t1", pid: process.pid })
  expect(files.list().map((f) => f.path)).toEqual([a, b])
  expect(sent.map((m) => JSON.parse(m))).toEqual([
    expect.objectContaining({
      type: "conversation",
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
  expect((await files.ensure(a)).session).toEqual({
    harness: "claude",
    socket: "/s/1.sock",
  })
  expect((await files.ensure(await md("b.md"))).session).toEqual(null)
  expect(files.list().length).toEqual(2)
})

test("close removes only that file", async () => {
  const a = await files.open(await md("a.md"), null)
  const b = await files.open(await md("b.md"), null)
  expect(files.close(a.id)?.path).toEqual(a.path)
  expect(files.close(a.id)).toEqual(undefined)
  expect(files.get(b.id)).toBe(b)
})
