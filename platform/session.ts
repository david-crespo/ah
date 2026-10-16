// Posting into an agent session. A command run in the session's shell knows
// which session it's in from what the harness exports to its children, and
// hands that to the server, as `ah view open` does; the server isn't
// the session's child, so it can't look for itself. Each harness takes a post
// its own way, and each starts a turn when the session is idle:
//
// - Claude Code binds a cross-session messaging inbox socket (a Unix domain
//   socket) and exports its path as CLAUDE_CODE_MESSAGING_SOCKET. Writing one
//   JSON line to it wakes an idle session or is read between tool calls in a
//   busy one. Docs: code.claude.com/docs/en/cross-session-messaging ("The
//   session's inbox socket").
// - Codex exports CODEX_THREAD_ID, and `codex queue --thread <id>` hands a
//   message to the TUI running that thread (found through
//   ~/.codex/ipc/ipc.sock). A busy session runs it as the next turn.
// - opencode 2 exports OPENCODE_SESSION_ID. Its sessions live in one
//   background service that every TUI is a client of; posting to the
//   service's /api/session/<id>/prompt steers a busy session mid-turn.

import { readFileSync, statSync } from "node:fs"
import { createConnection } from "node:net"
import { basename, join } from "node:path"
import { type Address, type AgentRef, HARNESSES } from "../core/model.ts"
import { isOneOf, isRecord } from "./guards.ts"
import { claudeConfigDirs, claudeSessionsDir, stateHome } from "./paths.ts"
import { ancestors, command, processTable, run } from "./proc.ts"

/** The harnesses ah can post into; the registry's `Harness` also has pi */
type PostHarness = Address["harness"]

/** An address as the CLI sent it, checked, or null if it isn't one */
export function parseAddress(value: unknown): Address | null {
  if (!isRecord(value)) return null
  switch (value.harness) {
    case "claude": {
      const { socket, token } = value
      if (
        typeof socket !== "string" ||
        !(token === undefined || typeof token === "string")
      ) {
        return null
      }
      return { harness: "claude", socket, token }
    }
    case "codex": {
      const { thread, pid } = value
      if (typeof thread !== "string" || !(pid === null || typeof pid === "number"))
        return null
      return { harness: "codex", thread, pid }
    }
    case "opencode":
      return typeof value.id === "string" ? { harness: "opencode", id: value.id } : null
    default:
      return null
  }
}

/** What the harnesses (and Rex) export that says which session and
 * block a process is in */
const SESSION_ENV = [
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "REX_BLOCK",
  "REX_SESSION",
]

/** For the server, which belongs to no session: it inherits the env of
 * whichever one started it, and anything it runs (a shell in a helix pane)
 * would otherwise think it's in that session */
export function scrubSessionEnv(env: NodeJS.ProcessEnv) {
  for (const name of SESSION_ENV) delete env[name]
}

/** The harness this command runs in, and the processes above it if they
 * were needed to tell (see `harnessesAbove`) */
function here(): { harness: PostHarness; procs: Ancestor[] } | null {
  const env = process.env
  const set: PostHarness[] = []
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) set.push("claude")
  if (env.CODEX_THREAD_ID) set.push("codex")
  if (env.OPENCODE_SESSION_ID) set.push("opencode")
  if (!set.length) return null
  // Codex's process is how its sessions are told apart
  const procs = set.includes("codex") || set.length > 1 ? harnessesAbove() : []
  // One harness run from another's shell inherits the outer one's
  // variables too; the nearer harness process is the one this runs in
  const nearest = procs.find((p) => p.harness && set.includes(p.harness))?.harness
  return { harness: nearest ?? set[0], procs }
}

/** Where to post to the session this command runs in, if it's in one */
export function currentAddress(): Address | null {
  const env = process.env
  const found = here()
  switch (found?.harness) {
    case undefined:
      return null
    case "claude":
      return {
        harness: "claude",
        socket: env.CLAUDE_CODE_MESSAGING_SOCKET!,
        token: env.CLAUDE_CODE_MESSAGING_TOKEN,
      }
    case "codex": {
      const pid = found.procs.find((p) => p.harness === "codex")?.pid ?? null
      return { harness: "codex", thread: env.CODEX_THREAD_ID!, pid }
    }
    case "opencode":
      return { harness: "opencode", id: env.OPENCODE_SESSION_ID! }
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** An agent a command names, checked, or null if it isn't one */
export function parseAgentRef(o: unknown): AgentRef | null {
  if (!isRecord(o) || !isOneOf(HARNESSES, o.harness)) return null
  return {
    harness: o.harness,
    session: str(o.session),
    block: str(o.block),
    process: str(o.process),
  }
}

/** Which agent a command runs under, for the server to find its record
 * (core/registry.ts): its harness and session, and its pane or,
 * outside Rex, its process. Claude and Codex: the harness's process, which
 * outlives a /clear or /new. opencode: the session, since its shell
 * commands all run under one service shared by every session. */
export function currentAgent(session = currentAddress()): AgentRef | null {
  const block = process.env.REX_BLOCK || null
  switch (session?.harness) {
    case undefined:
      return null
    case "claude": {
      const pid = process.env.CLAUDE_PID
      return {
        harness: "claude",
        session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        block,
        process: pid ? `claude-${pid}` : null,
      }
    }
    case "codex": {
      const { pid, thread } = session
      return {
        harness: "codex",
        session: thread,
        block,
        process: pid ? `codex-${pid}` : null,
      }
    }
    case "opencode":
      return {
        harness: "opencode",
        session: session.id,
        block,
        process: `opencode-${session.id}`,
      }
  }
}

type Ancestor = { pid: number; harness: PostHarness | null }

/** The processes above this one, nearest first, each with the harness it
 * is, if any. Claude's is CLAUDE_PID. Codex runs shell commands as children
 * of its native binary, itself under the node wrapper npm installs as
 * `codex`. opencode runs every session's commands under its one service. */
function harnessesAbove(): Ancestor[] {
  const claudePid = Number(process.env.CLAUDE_PID)
  return ancestors(processTable()).map(({ pid, args }) => {
    const comm = command(args)
    const harness: PostHarness | null =
      pid === claudePid
        ? "claude"
        : comm === "codex"
          ? "codex"
          : comm.startsWith("opencode")
            ? "opencode"
            : null
    return { pid, harness }
  })
}

/** For `ls` and logs: the harness and where posts go, never the token */
export function describeAddress(address: Address): string {
  switch (address.harness) {
    case "claude":
      return `claude ${address.socket}`
    case "codex":
      return `codex ${address.thread}`
    case "opencode":
      return `opencode ${address.id}`
  }
}

// Whether a session still runs, which decides whether a post can go to it,
// so a Codex session whose TUI pid isn't known is assumed there until a post
// fails. A reused pid passes for Codex. Claude removes its
// <config dir>/sessions/<pid>.json, in whichever config dir it runs under, when the session exits, so a reused pid
// doesn't fool that check, and the socket file, which can outlive the
// process, is only a fallback. Sync so the feed snapshot can include it
// without promises.

export function addressAlive(address: Address | null): boolean {
  if (!address) return false
  switch (address.harness) {
    case "claude": {
      const pid = basename(address.socket).match(/^(\d+)\.sock$/)?.[1]
      return pid
        ? claudeConfigDirs().some((d) => exists(join(claudeSessionsDir(d), `${pid}.json`)))
        : exists(address.socket)
    }
    case "codex":
      return address.pid === null || processRunning(address.pid)
    case "opencode":
      return opencodeRunning()
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether a process with this pid exists. A reused pid passes too. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists but isn't ours
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function postTo(address: Address, text: string): Promise<void> {
  switch (address.harness) {
    case "claude":
      return await postToClaude(address, text)
    case "codex": {
      // Exits nonzero when no running TUI has the thread
      const queued = await run(
        "codex",
        ["queue", "--thread", address.thread, "--message", text],
        { timeout: 10_000 },
      )
      if (!queued.success) throw new Error(`codex queue: ${queued.stderr.trim()}`)
      return
    }
    case "opencode":
      return await postToOpencode(address.id, text)
  }
}

async function postToClaude(
  address: Extract<Address, { harness: "claude" }>,
  text: string,
): Promise<void> {
  const lines: string[] = []
  if (address.token) lines.push(JSON.stringify({ type: "auth", token: address.token }))
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }))
  // Open only once the message is ready: the address drops connections that
  // go 30s without a complete line. The address closes right after reading
  // the line, but the timeout bounds the wait in case it ever doesn't, since
  // delivery holds up the comment POST. A timeout counts as not delivered: the
  // comment waits in the log for the address to catch up on.
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(address.socket)
    conn.setTimeout(2000, () =>
      conn.destroy(new Error("timed out waiting for the address to read the post")),
    )
    conn.on("error", reject)
    conn.on("close", () => resolve())
    conn.end(lines.join("\n") + "\n")
  })
}

/** opencode sessions outlive their TUIs in the service, so the service
 * running is as close as it gets to one being alive */
export function opencodeRunning(): boolean {
  const service = opencodeService()
  return service !== null && processRunning(service.pid)
}

type OpencodeService = { url: string; pid: number; password: string }

/** Whichever TUI started the service (re)wrote service.json with its URL and
 * password (0600). opencode's main branch has since split the password into
 * its own file beside server.json, so read either. */
export function opencodeService(): OpencodeService | null {
  const dir = join(stateHome(), "opencode")
  for (const name of ["service.json", "server.json"]) {
    try {
      const service = JSON.parse(readFileSync(join(dir, name), "utf8"))
      const password =
        service.password ?? readFileSync(join(dir, "password"), "utf8").trim()
      return { url: service.url, pid: service.pid, password }
    } catch {}
  }
  return null
}

async function postToOpencode(id: string, text: string): Promise<void> {
  const service = opencodeService()
  if (!service) throw new Error("opencode's service isn't running")
  const auth = Buffer.from(`opencode:${service.password}`).toString("base64")
  const response = await fetch(new URL(`/api/session/${id}/prompt`, service.url), {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`opencode: ${response.status} ${await response.text()}`)
}
