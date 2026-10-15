import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { LiveDoc } from "../../app/markdown/doc.ts"
import { parseActivity, parseUser } from "./events.ts"
import { header, Thread } from "./thread.ts"

let dir: string
let docs: LiveDoc[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-thread-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
})
afterEach(async () => {
  for (const doc of docs) doc.close()
  docs = []
  delete process.env.XDG_STATE_HOME
  await rm(dir, { recursive: true })
})

/** A stand-in for a session's inbox socket: what each connection wrote */
async function inbox() {
  const socket = join(dir, "inbox.sock")
  const posts: string[] = []
  const server = createServer((conn) => {
    let text = ""
    conn.on("data", (chunk) => (text += chunk))
    conn.on("end", () => {
      posts.push(text)
      conn.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(socket, resolve)
  })
  return { socket, posts, close: () => server.close() }
}

/** A thread on a markdown file, set up as the markdown app does */
const markdownThread = (file: Parameters<typeof Thread.open>[0], doc: LiveDoc) =>
  Thread.open(file, {
    app: "markdown",
    port: 7420,
    broadcast: () => {},
    context: async () => {
      await doc.refresh()
      return doc.takeEdit()
    },
  })

async function markdownFile(text: string) {
  const path = join(dir, "notes.md")
  await writeFile(path, text)
  const doc = await LiveDoc.open(path)
  docs.push(doc)
  return { path, doc }
}

test("a comment goes to the bound session after the edits it follows", async () => {
  const session = await inbox()
  try {
    const { path, doc } = await markdownFile("hello world\n")
    const file = {
      path,
      address: () => ({ harness: "claude" as const, socket: session.socket, token: "t" }),
    }
    const thread = await markdownThread(file, doc)
    await writeFile(path, "hello there\n")
    const { event, agentConnected } = await thread.comment(
      parseUser({ kind: "comment", text: "warmer", selection: "there" }),
    )
    expect(agentConnected).toEqual(true)
    const lines = session.posts[0]
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: "auth", token: "t" })
    const content: string[] = lines[1].message.content.split("\n")
    expect(content[0]).toEqual(header({ app: "markdown" }, path, 7420))
    expect(JSON.parse(content[1])).toMatchObject({ kind: "file-edit", new: "there" })
    expect(JSON.parse(content[2])).toMatchObject({ id: event.id, text: "warmer" })
  } finally {
    session.close()
  }
})

test("without a session, a comment is kept for later and activity still lands", async () => {
  const { path, doc } = await markdownFile("text\n")
  const file = { path, address: () => null }
  const thread = await markdownThread(file, doc)
  const { event, agentConnected } = await thread.comment(
    parseUser({ kind: "message", text: "hi" }),
  )
  expect(agentConnected).toEqual(false)
  await thread.activity(
    parseActivity({ phase: "start", requestIds: [event.id], workId: "w1" }),
  )
  await thread.activity(
    parseActivity({ phase: "done", requestIds: [event.id], workId: "w1", text: "ok" }),
  )
  expect(thread.state().requests).toMatchObject([{ id: event.id, status: "done" }])
  // The log outlives the server
  const reopened = await markdownThread(file, doc)
  expect(reopened.state().events.length).toEqual(3)
})

test("comments no agent took go to the next one, unless handled by then", async () => {
  const agent = await inbox()
  try {
    const { path, doc } = await markdownFile("text\n")
    let address: { harness: "claude"; socket: string } | null = null
    const sent: { agentConnected: boolean }[] = []
    const thread = await Thread.open(
      { path, address: () => address },
      {
        app: "markdown",
        port: 7420,
        broadcast: (m) => sent.push(JSON.parse(m)),
        context: async () => (await doc.refresh(), doc.takeEdit()),
      },
    )
    const first = await thread.comment(parseUser({ kind: "message", text: "one" }))
    const second = await thread.comment(parseUser({ kind: "message", text: "two" }))
    expect([first.agentConnected, second.agentConnected]).toEqual([false, false])
    // Nothing changed: the pages aren't told again
    await thread.refresh()
    expect(sent.length).toEqual(2)
    // The second was caught up on with `pending` and started
    await thread.activity(
      parseActivity({ phase: "start", requestIds: [second.event.id], workId: "w1" }),
    )
    address = { harness: "claude", socket: agent.socket }
    await thread.refresh()
    expect(sent.at(-1)?.agentConnected).toEqual(true)
    expect(agent.posts.length).toEqual(1)
    expect(agent.posts[0]).toContain(first.event.id)
    expect(agent.posts[0]).not.toContain(second.event.id)
    // Sent once
    await thread.refresh()
    expect(agent.posts.length).toEqual(1)
  } finally {
    agent.close()
  }
})

test("the header names the port only when it isn't the default", () => {
  expect(header({ app: "markdown" }, "/d.md", 7420)).toEqual(
    "Markdown event for /d.md (handle per /markdown skill):",
  )
  expect(header({ app: "markdown" }, "/d.md", 7499)).toContain("port 7499")
})

test("an app can title itself in the header", () => {
  expect(header({ app: "html", title: "HTML" }, "/d.html", 7420)).toEqual(
    "HTML event for /d.html (handle per /html skill):",
  )
})
