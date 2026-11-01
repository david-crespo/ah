// The Helix pane taking the agent's edits, end to end: real hx in a pty
// (pty.ts, helix_command.ts), editors/helix/auto-merge.scm, and `ah view
// merge` from this checkout, which runs in any helix, not just the pane.
// Needs hx built with Steel and its generated helix/*.scm modules
// (docs/helix.md); skipped without hx on PATH. Checks on a timer with that
// hx, or on its document-changed-on-disk hook if it has one. Helix gets a
// config directory of its own whose helix.scm loads only ah.scm, so the
// user's Steel config doesn't matter. With an hx that has sessions (the
// user's fork), two panes also share one editor (auto-merge-clients.scm).

import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { WebSocket } from "ws"
import { helixCommand } from "./helix_command.ts"
import { PtyBackend } from "./pty.ts"

const help = spawnSync("hx", ["--help"])
const hx = help.status === 0
const sessions = hx && /\s--session\b/.test(help.stdout.toString())

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

/** A file once it has all of `texts`, or after a few seconds anyway */
async function fileWith(path: string, ...texts: string[]) {
  let text = ""
  for (let i = 0; i < 50; i++) {
    text = await readFile(path, "utf8")
    if (texts.every((t) => text.includes(t))) break
    await sleep(100)
  }
  return text
}

/** The environment for a pane's hx in `dir`: a config directory whose
 * helix.scm loads only ah.scm, as docs/helix.md has it, with `init.scm`
 * and `config.toml`, and this checkout's ah for the script's `ah view
 * merge` */
async function helixEnv(dir: string, init: string, configToml = "") {
  const config = join(dir, "config")
  await mkdir(join(config, "helix"), { recursive: true })
  await symlink(resolve("editors/helix"), join(config, "helix/ah"))
  await writeFile(
    join(config, "helix/helix.scm"),
    '(require "ah/ah.scm")\n(provide set-merge-unit!)\n',
  )
  await writeFile(join(config, "helix/init.scm"), init)
  await writeFile(join(config, "helix/config.toml"), configToml)
  const bin = join(dir, "bin")
  await mkdir(bin)
  await symlink(resolve("ah.ts"), join(bin, "ah"))
  return { PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: config }
}

/** A pane on `file`, once hx has started with its Steel config loaded */
async function openPane(file: string, env: Record<string, string>, socket: Socket) {
  const pane = new PtyBackend(file, helixCommand, env)
  await pane.connect(
    socket as unknown as WebSocket,
    new URLSearchParams("cols=120&rows=30"),
  )
  while (!socket.output.includes(basename(file))) await sleep(50)
  await sleep(1000)
  return pane
}

describe.skipIf(!hx)(
  "helix pane",
  () => {
    let dir: string
    let file: string
    let pane: PtyBackend
    const socket = new Socket()

    const disk = (...texts: string[]) => fileWith(file, ...texts)

    /** The text in Helix's buffer, piped out to a file */
    async function buffer() {
      const out = join(dir, "buffer")
      await rm(out, { force: true })
      socket.type(`%:pipe-to cat > ${out}\r`)
      for (let i = 0; i < 50; i++) {
        const text = await readFile(out, "utf8").catch(() => null)
        if (text) return text
        await sleep(100)
      }
      return ""
    }

    /** The agent's Edit tool: replace exact text in a file */
    async function agent(before: string, after: string, path = file) {
      const text = await readFile(path, "utf8")
      expect(text).toContain(before)
      await writeFile(path, text.replace(before, after))
    }

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "ah-helix-pane-"))
      file = join(dir, "notes.md")
      await writeFile(
        file,
        "# Notes\n\nSessions are stored in a SQLite database. Each session row has an id, a title, and the time it was last opened. The dashboard reads this table on startup.\n\nScrollback is kept in memory only, so it does not survive a restart. If you need a log, pipe the command through tee.\n",
      )
      // With one extension merged the other way
      const env = await helixEnv(dir, `(set-merge-unit! "text" 'words)\n`)
      pane = await openPane(file, env, socket)
    })

    afterAll(async () => {
      pane?.close()
      await rm(dir, { recursive: true, force: true })
    })

    // The tests run in order, each on the file as the last left it

    test("reloads the agent's edit into an unmodified buffer", async () => {
      await agent("last opened", "last active")
      await sleep(800)
      // Reloaded already, not merged when typing ends below
      expect(await buffer()).toContain("last active")
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

    test("marks both versions of a sentence both sides changed", async () => {
      socket.type("/a restart\r")
      await sleep(200)
      socket.type("iserver ")
      socket.type(ESC)
      await sleep(50)
      await agent("so it does not survive a restart", "and is lost when the server stops")
      const text = await disk("server a restart")
      await sleep(300)
      expect(socket.output).toContain("with 1 conflict marked")
      expect(text).toContain(
        "{~~Scrollback is kept in memory only, so it does not survive server a restart.~>Scrollback is kept in memory only, and is lost when the server stops.~~}",
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

    /** Opens a file of four lines, types a word into the second, and has
     * the agent change the second and fourth while in insert mode: the file
     * once merged */
    async function mergeLines(name: string) {
      const path = join(dir, name)
      const text = "alpha one\nbeta two\ngamma three\ndelta four\n"
      await writeFile(path, text)
      socket.type(`:open ${path}\r`)
      expect(await buffer()).toBe(text)
      socket.type("/beta\r")
      await sleep(200)
      socket.type("ibig ")
      await sleep(200)
      await agent("beta two", "beta 2", path)
      await agent("delta four", "delta 4", path)
      await sleep(800)
      socket.type(ESC)
      return fileWith(path, "big beta")
    }

    test("merges a file that isn't markdown by lines", async () => {
      // A word apart on one line, which by words would merge
      expect(await mergeLines("notes.txt")).toBe(
        "alpha one\n<<<<<<< mine\nbig beta two\n=======\nbeta 2\n>>>>>>> agent\ngamma three\ndelta 4\n",
      )
    })

    test("merges by words where init.scm says to", async () => {
      expect(await mergeLines("notes.text")).toBe(
        "alpha one\nbig beta 2\ngamma three\ndelta 4\n",
      )
    })

    test("leaves a file that isn't UTF-8 to the user", async () => {
      const path = join(dir, "latin1.txt")
      await writeFile(path, Buffer.from("caf\xe9 one\ntwo\n", "latin1"))
      socket.type(`:open ${path}\r`)
      expect(await buffer()).toBe("café one\ntwo\n")
      socket.type("ggibig ")
      await sleep(200)
      const agents = Buffer.from("caf\xe9 one\n2\n", "latin1")
      await writeFile(path, agents)
      await sleep(800)
      socket.type(ESC)
      await sleep(800)
      expect(socket.output).toContain("isn't UTF-8 text to merge")
      expect(await readFile(path)).toEqual(agents)
    })
  },
  30_000,
)

describe.skipIf(!sessions)(
  "helix panes sharing a session",
  () => {
    let dir: string
    let file: string
    const panes: PtyBackend[] = []
    const typing = new Socket()
    const other = new Socket()

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "ah-helix-session-"))
      file = join(dir, "notes.txt")
      await writeFile(file, "one\ntwo\n")
      const env = await helixEnv(dir, "", '[editor]\nsession = "auto"\n')
      Object.assign(env, { HELIX_SESSION: `ah-test-${process.pid}` })
      for (const socket of [typing, other]) panes.push(await openPane(file, env, socket))
    })

    afterAll(async () => {
      for (const pane of panes) pane.close()
      await rm(dir, { recursive: true, force: true })
    })

    test("waits to merge while any client is typing in the file", async () => {
      typing.type("omine")
      await sleep(200)
      // The other client acted last, so a check that asked only it would
      // merge now
      other.type("k")
      await sleep(200)
      await writeFile(file, "zero\none\ntwo\n")
      await sleep(800)
      expect(await readFile(file, "utf8")).toBe("zero\none\ntwo\n")
      typing.type(ESC)
      expect(await fileWith(file, "mine")).toBe("zero\none\nmine\ntwo\n")
    })
  },
  30_000,
)
