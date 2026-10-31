// The Helix pane taking the agent's edits, end to end: real hx in a pty
// (pty.ts, helix_command.ts), editors/helix/auto-merge.scm, and the merge
// route (routes.ts) on a server of its own. Needs hx built with Steel and its
// generated helix/*.scm modules (docs/helix.md); skipped without hx on PATH.
// Helix gets a config directory of its own whose helix.scm loads only ah.scm,
// so the user's Steel config doesn't matter.

import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { WebSocket } from "ws"
import { helixCommand } from "./helix_command.ts"
import { PtyBackend } from "./pty.ts"
import { merge } from "./routes.ts"

const hx = spawnSync("hx", ["--version"]).status === 0

/** Escape, as the page sends it (helix.ts) */
const ESC = "\x1b[27u"

/** The pane's socket, as PtyBackend uses it */
class Socket extends EventEmitter {
  OPEN = 1
  readyState = 1
  output = ""
  send(data: Buffer) {
    this.output += data.toString()
  }
  close() {
    this.readyState = 3
    this.emit("close")
  }
  /** Keys typed in the pane */
  type(data: string) {
    this.emit("message", Buffer.from(JSON.stringify({ type: "input", data })), false)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hx)(
  "helix pane",
  () => {
    let dir: string
    let file: string
    let server: Server
    let pane: PtyBackend
    const socket = new Socket()

    /** The file once it has all of `texts`, or after a few seconds anyway */
    async function disk(...texts: string[]) {
      let text = ""
      for (let i = 0; i < 50; i++) {
        text = await readFile(file, "utf8")
        if (texts.every((t) => text.includes(t))) break
        await sleep(100)
      }
      return text
    }

    /** The agent's Edit tool: replace exact text in the file */
    async function agent(before: string, after: string) {
      const text = await readFile(file, "utf8")
      expect(text).toContain(before)
      await writeFile(file, text.replace(before, after))
    }

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "ah-helix-pane-"))
      file = join(dir, "notes.md")
      await writeFile(
        file,
        "# Notes\n\nSessions are stored in a SQLite database. Each session row has an id, a title, and the time it was last opened. The dashboard reads this table on startup.\n\nScrollback is kept in memory only, so it does not survive a restart. If you need a log, pipe the command through tee.\n",
      )
      const config = join(dir, "config")
      await mkdir(join(config, "helix"), { recursive: true })
      await symlink(resolve("editors/helix"), join(config, "helix/ah"))
      await writeFile(join(config, "helix/helix.scm"), '(require "ah/ah.scm")\n')
      // Helix runs no Steel config without an init.scm
      await writeFile(join(config, "helix/init.scm"), "")

      server = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const reply = await merge(
          new Request(`http://localhost${req.url}`, {
            method: "POST",
            headers: req.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          }),
        )
        res.writeHead(reply.status).end(await reply.text())
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as AddressInfo

      pane = new PtyBackend(file, helixCommand, {
        AH_MERGE_URL: `http://127.0.0.1:${port}/merge`,
        XDG_CONFIG_HOME: config,
      })
      await pane.connect(
        socket as unknown as WebSocket,
        new URLSearchParams("cols=120&rows=30"),
      )
      // Started, with its Steel config loaded
      while (!socket.output.includes("notes.md")) await sleep(50)
      await sleep(1000)
    })

    afterAll(async () => {
      pane?.close()
      server?.close()
      await rm(dir, { recursive: true, force: true })
    })

    // The tests run in order, each on the file as the last left it

    test("reloads the agent's edit into an unmodified buffer", async () => {
      await agent("last opened", "last active")
      await sleep(800)
      // A line typed after the reload saves on top of the agent's edit
      socket.type("ggOTyped first.")
      socket.type(ESC)
      expect(await disk("Typed first.")).toContain("last active")
    })

    test("merges the agent's edit into unsaved typing when insert mode ends", async () => {
      socket.type("/a title\r")
      await sleep(200)
      socket.type("ishort ")
      await sleep(200)
      await agent("on startup", "when it starts")
      await sleep(800)
      expect(await readFile(file, "utf8")).not.toContain("short")
      socket.type(ESC)
      const text = await disk("short")
      expect(text).toContain("short a title")
      expect(text).toContain("when it starts")
    })

    test("keeps both versions of a sentence both sides changed", async () => {
      socket.type("/a restart\r")
      await sleep(200)
      socket.type("iserver ")
      socket.type(ESC)
      await sleep(50)
      await agent("so it does not survive a restart", "and is lost when the server stops")
      const text = await disk("server a restart")
      expect(text).toContain(
        "Scrollback is kept in memory only, so it does not survive server a restart. Scrollback is kept in memory only, and is lost when the server stops.",
      )
    })

    test("saves later typing without losing either side's edits", async () => {
      socket.type("GoTyped last.")
      socket.type(ESC)
      const text = await disk("Typed last.")
      for (const t of ["Typed first.", "short a title", "when it starts", "server stops"]) {
        expect(text).toContain(t)
      }
    })
  },
  30_000,
)
