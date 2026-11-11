import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { ask, type Question } from "./ask.ts"

// The window app, played by a server on a Unix socket that answers each
// connection as `reply` says, and records the lines it was sent
const dir = mkdtempSync(join(tmpdir(), "ah-ask-"))
afterAll(() => rmSync(dir, { recursive: true }))

const question: Question = {
  heading: "Push it?",
  notes: ['A "note"\nover two lines'],
  rows: [{ id: "abcdefgh", text: "Say <b>hi</b>" }],
  more: 0,
  button: "Push",
}

async function app(reply: (conn: Socket) => void) {
  const socket = join(dir, `${Math.random().toString(36).slice(2)}.sock`)
  const lines: string[] = []
  const server = createServer((conn) => {
    conn.setEncoding("utf8")
    let got = ""
    conn.on("data", (chunk: string) => {
      got += chunk
      if (!got.includes("\n")) return
      lines.push(got)
      reply(conn)
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return { socket, lines, close: () => server.close() }
}

test("the question goes as one line of JSON, and yes is yes", async () => {
  const { socket, lines, close } = await app((conn) => conn.end("yes\n"))
  expect(await ask(socket, question)).toBe(true)
  expect(lines).toEqual([`${JSON.stringify(question)}\n`])
  close()
})

test("no, a hang-up, no app and no answer in time are all no", async () => {
  const no = await app((conn) => conn.end("no\n"))
  expect(await ask(no.socket, question)).toBe(false)
  const hangUp = await app((conn) => conn.destroy())
  expect(await ask(hangUp.socket, question)).toBe(false)
  expect(await ask(join(dir, "none.sock"), question)).toBe(false)
  const silent = await app(() => {})
  expect(await ask(silent.socket, question, 50)).toBe(false)
  for (const a of [no, hangUp, silent]) a.close()
})
