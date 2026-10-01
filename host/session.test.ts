import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { type AddressInfo, createServer as createSocketServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import {
  currentAgent,
  currentSession,
  postToSession,
  scrubSessionEnv,
  sessionAlive,
} from "./session.ts"

const vars = [
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "GHOSTTY_TERMINAL_ID",
  "XDG_STATE_HOME",
  "PATH",
]
let saved: Record<string, string | undefined>
let dir: string
beforeEach(async () => {
  saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]))
  for (const v of vars.slice(0, 7)) delete process.env[v]
  dir = await mkdtemp(join(tmpdir(), "ah-session-"))
})
afterEach(async () => {
  for (const [v, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[v]
    else process.env[v] = value
  }
  await rm(dir, { recursive: true })
})

test("the session comes from whichever harness's variables are set", () => {
  expect(currentSession()).toBeNull()
  process.env.OPENCODE_SESSION_ID = "ses_1"
  expect(currentSession()).toEqual({ harness: "opencode", id: "ses_1" })
  delete process.env.OPENCODE_SESSION_ID
  process.env.CODEX_THREAD_ID = "019a"
  expect(currentSession()).toEqual({ harness: "codex", thread: "019a", pid: null })
  delete process.env.CODEX_THREAD_ID
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/s/1.sock"
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = "t"
  expect(currentSession()).toEqual({ harness: "claude", socket: "/s/1.sock", token: "t" })
})

test("a Codex post queues the text on the thread", async () => {
  const bin = join(dir, "bin")
  await mkdir(bin)
  const argsFile = join(dir, "args")
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\necho "Queued message 1 for thread $3"\n`,
  )
  await chmod(join(bin, "codex"), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  await postToSession({ harness: "codex", thread: "019a", pid: null }, "Markdown event\n{}")
  expect(await readFile(argsFile, "utf8")).toEqual(
    "queue\n--thread\n019a\n--message\nMarkdown event\n{}\n",
  )
})

test("a Codex post fails when no TUI has the thread", async () => {
  const bin = join(dir, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "codex"), "#!/bin/sh\necho 'no such thread' >&2\nexit 1\n")
  await chmod(join(bin, "codex"), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  await expect(
    postToSession({ harness: "codex", thread: "019a", pid: null }, "hi"),
  ).rejects.toThrow("no such thread")
})

test("a Claude post that the session never closes on fails", async () => {
  const socket = join(dir, "inbox.sock")
  // Reads the post but never hangs up
  const server = createSocketServer(() => {})
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    await expect(postToSession({ harness: "claude", socket }, "hi")).rejects.toThrow(
      /timed out/,
    )
  } finally {
    server.close()
  }
})

test("an opencode post prompts the session through the service", async () => {
  const requests: { url?: string; auth?: string; body: string }[] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body })
      res.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = server.address() as AddressInfo
    process.env.XDG_STATE_HOME = dir
    await mkdir(join(dir, "opencode"))
    const service = { url: `http://127.0.0.1:${port}`, pid: process.pid, password: "pw" }
    await writeFile(join(dir, "opencode", "service.json"), JSON.stringify(service))
    const session = { harness: "opencode", id: "ses_1" } as const
    expect(sessionAlive(session)).toEqual(true)
    await postToSession(session, "Markdown event\n{}")
    expect(requests).toEqual([
      {
        url: "/api/session/ses_1/prompt",
        auth: `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
        body: JSON.stringify({ text: "Markdown event\n{}" }),
      },
    ])
  } finally {
    server.close()
  }
})

test("an opencode session is gone when the service isn't running", () => {
  process.env.XDG_STATE_HOME = dir
  expect(sessionAlive({ harness: "opencode", id: "ses_1" })).toEqual(false)
})

test("a scrubbed env is no session's, whichever harness started it", () => {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_MESSAGING_SOCKET: "/s/1.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDE_PID: "123",
    CLAUDE_CODE_SESSION_ID: "abc",
    CODEX_THREAD_ID: "thread",
    OPENCODE_SESSION_ID: "ses",
    GHOSTTY_TERMINAL_ID: "term",
    HOME: "/home/me",
  }
  scrubSessionEnv(env)
  expect(env).toEqual({ HOME: "/home/me" })
  Object.assign(process.env, { CODEX_THREAD_ID: "thread", CLAUDE_PID: "123" })
  scrubSessionEnv(process.env)
  expect(currentSession()).toEqual(null)
  expect(currentAgent()).toEqual(null)
})
