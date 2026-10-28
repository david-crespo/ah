import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { LiveDoc } from "../../views/markdown/doc.ts"
import { parseActivity, parseRequest } from "./events.ts"
import { threadKinds } from "./kinds.ts"
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

/** A thread on a markdown file, set up as the markdown backend does */
const markdownThread = (file: Parameters<typeof Thread.open>[0], doc: LiveDoc) =>
  Thread.open(file, {
    kind: "markdown",
    kinds: threadKinds,
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

test("a request goes to the bound session, rendered, after the edits it follows", async () => {
  const session = await inbox()
  try {
    const { path, doc } = await markdownFile("hello world\n")
    const file = {
      path,
      address: () => ({ harness: "claude" as const, socket: session.socket }),
    }
    const thread = await markdownThread(file, doc)
    await writeFile(path, "hello there\n")
    const { request, agentConnected } = await thread.request(
      parseRequest(
        { kind: "comment", text: "warmer", args: { selection: "there", prefix: "hello " } },
        threadKinds,
      ),
    )
    expect(agentConnected).toEqual(true)
    const lines = session.posts[0]
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    const content: string[] = lines[0].message.content.split("\n")
    expect(content[0]).toEqual(header({ kind: "markdown" }, path, 7420))
    expect(content[1]).toEqual(
      'Edit notice: since the last request, the file on disk replaced "world" with "there" after "hello "',
    )
    expect(content.slice(2)).toEqual([
      `Request ${request.id}: a comment on the passage "there" (after "hello "):`,
      "warmer",
    ])
  } finally {
    session.close()
  }
})

test("without a session, a request is kept for later and activity still lands", async () => {
  const { path, doc } = await markdownFile("text\n")
  const file = { path, address: () => null }
  const thread = await markdownThread(file, doc)
  const { request, agentConnected } = await thread.request(
    parseRequest({ kind: "chat", text: "hi" }, threadKinds),
  )
  expect(agentConnected).toEqual(false)
  await thread.activity(
    parseActivity({ phase: "start", requests: [request.id], workId: "w1" }),
  )
  await thread.activity(
    parseActivity({ phase: "done", requests: [request.id], workId: "w1", text: "ok" }),
  )
  expect(thread.state().requests).toMatchObject([{ id: request.id, status: "done" }])
  // The log outlives the server
  const reopened = await markdownThread(file, doc)
  expect(reopened.state().entries.length).toEqual(3)
})

test("requests no agent took go to the next one, unless handled by then", async () => {
  const agent = await inbox()
  try {
    const { path, doc } = await markdownFile("text\n")
    let address: { harness: "claude"; socket: string } | null = null
    const sent: { agentConnected: boolean }[] = []
    const thread = await Thread.open(
      { path, address: () => address },
      {
        kind: "markdown",
        kinds: threadKinds,
        port: 7420,
        broadcast: (m) => sent.push(JSON.parse(m)),
        context: async () => (await doc.refresh(), doc.takeEdit()),
      },
    )
    const chat = (text: string) => parseRequest({ kind: "chat", text }, threadKinds)
    const first = await thread.request(chat("one"))
    const second = await thread.request(chat("two"))
    expect([first.agentConnected, second.agentConnected]).toEqual([false, false])
    // Nothing changed: the pages aren't told again
    await thread.refresh()
    expect(sent.length).toEqual(2)
    // The second was caught up on with `pending` and started
    await thread.activity(
      parseActivity({ phase: "start", requests: [second.request.id], workId: "w1" }),
    )
    address = { harness: "claude", socket: agent.socket }
    await thread.refresh()
    expect(sent.at(-1)?.agentConnected).toEqual(true)
    expect(agent.posts.length).toEqual(1)
    expect(agent.posts[0]).toContain(first.request.id)
    expect(agent.posts[0]).not.toContain(second.request.id)
    // Sent once
    await thread.refresh()
    expect(agent.posts.length).toEqual(1)
  } finally {
    agent.close()
  }
})

test("a request no agent took is still held after a restart", async () => {
  const agent = await inbox()
  try {
    const { path, doc } = await markdownFile("text\n")
    let address: { harness: "claude"; socket: string } | null = null
    const file = { path, address: () => address }
    const before = await markdownThread(file, doc)
    const held = await before.request(
      parseRequest({ kind: "chat", text: "one" }, threadKinds),
    )
    address = { harness: "claude", socket: agent.socket }
    const sent = await before.request(
      parseRequest({ kind: "chat", text: "two" }, threadKinds),
    )
    expect([held.agentConnected, sent.agentConnected]).toEqual([false, true])
    const after = await markdownThread(file, doc)
    await after.refresh()
    expect(agent.posts.length).toEqual(2)
    expect(agent.posts[1]).toContain(held.request.id)
    expect(agent.posts[1]).not.toContain(sent.request.id)
    await after.refresh()
    expect(agent.posts.length).toEqual(2)
  } finally {
    agent.close()
  }
})

test("a held request keeps the edit notice it came with", async () => {
  const agent = await inbox()
  try {
    const { path, doc } = await markdownFile("hello world\n")
    let address: { harness: "claude"; socket: string } | null = null
    const holds: boolean[] = []
    const thread = await Thread.open(
      { path, address: () => address },
      {
        kind: "markdown",
        kinds: threadKinds,
        port: 7420,
        broadcast: () => {},
        context: async () => (await doc.refresh(), doc.takeEdit()),
        hold: (held) => holds.push(held),
      },
    )
    await writeFile(path, "hello there\n")
    await thread.request(parseRequest({ kind: "chat", text: "one" }, threadKinds))
    address = { harness: "claude", socket: agent.socket }
    await thread.refresh()
    expect(holds).toEqual([true, false])
    const content = JSON.parse(agent.posts[0].trim()).message.content
    expect(content).toContain('replaced "world" with "there"')
  } finally {
    agent.close()
  }
})

test("the header gives the reply command, with the port only when it isn't the default", () => {
  expect(header({ kind: "markdown" }, "/d.md", 7420)).toEqual(
    "Markdown requests for /d.md (load the /markdown skill before handling these, and answer on the page with ah message respond /d.md <phase> <request ids>):",
  )
  expect(header({ kind: "markdown" }, "/d.md", 7499)).toContain(
    "ah message respond -p 7499 /d.md <phase>",
  )
})

test("the header quotes a path that isn't one shell word", () => {
  expect(header({ kind: "markdown" }, "/my notes/it's.md", 7420)).toContain(
    "ah message respond '/my notes/it'\\''s.md' <phase>",
  )
})

test("a type can title itself in the header", () => {
  expect(header({ kind: "html", title: "HTML" }, "/d.html", 7420)).toMatch(
    /^HTML requests for \/d\.html \(load the \/html skill /,
  )
})
