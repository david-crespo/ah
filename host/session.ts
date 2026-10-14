// Posting into an agent session. A command run in the session's shell knows
// which session it's in from what the harness exports to its children, and
// hands that to the server, as `ah app markdown open` does; the server isn't
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
import { isRecord } from "./guards.ts"
import { claudeSessionsDir, stateHome } from "./paths.ts"
import { ancestors, command, processTable, run } from "./proc.ts"

export type Session =
  | {
      harness: "claude"
      socket: string
      // Exported alongside the socket; sending it as an auth line lets the
      // session verify the post came from its own child even after process
      // evidence is gone
      token?: string
    }
  // The TUI's process, if it could be found, since Codex keeps no record of
  // which threads are running
  | { harness: "codex"; thread: string; pid: number | null }
  | { harness: "opencode"; id: string }

/** The harnesses ah can post into; the registry's `Harness` also has pi */
type PostHarness = Session["harness"]

/** A session as the CLI sent it, checked, or null if it isn't one */
export function parseSession(value: unknown): Session | null {
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

/** What the harnesses (and the terminals) export that says which session and
 * terminal a process is in */
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

/** The session this command runs in, if any */
export function currentSession(): Session | null {
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

/** The agent a command runs under, for records that should last as long as
 * it does. Claude and Codex: the harness's process, which outlives a /clear
 * or /new. opencode: the session, since its shell commands all run under one
 * service shared by every session. */
export interface Agent {
  harness: PostHarness
  /** Unique across harnesses, safe in a file name */
  key: string
  pid: number | null
  sessionId: string | null
}

export function currentAgent(): Agent | null {
  const session = currentSession()
  switch (session?.harness) {
    case undefined:
      return null
    case "claude": {
      if (!process.env.CLAUDE_PID) return null
      const pid = Number(process.env.CLAUDE_PID)
      const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null
      return { harness: "claude", key: `claude-${pid}`, pid, sessionId }
    }
    case "codex": {
      const { pid, thread } = session
      if (!pid) {
        console.error(
          "ah: no codex process above this one; is ah running in Codex's sandbox?",
        )
        return null
      }
      return { harness: "codex", key: `codex-${pid}`, pid, sessionId: thread }
    }
    case "opencode": {
      const { id } = session
      return { harness: "opencode", key: `opencode-${id}`, pid: null, sessionId: id }
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
export function describeSession(session: Session): string {
  switch (session.harness) {
    case "claude":
      return `claude ${session.socket}`
    case "codex":
      return `codex ${session.thread}`
    case "opencode":
      return `opencode ${session.id}`
  }
}

// Whether a session still runs, asked for two reasons. `sessionAlive` decides
// whether a post can go to it, so a Codex session whose TUI pid isn't known
// is assumed there until a post fails. `agentAlive` decides whether the
// dashboard deletes a session's record, so it assumes the opposite: an
// optimistic answer would keep the record forever. A reused pid passes for
// Codex. Claude removes its ~/.claude/sessions/<pid>.json when the session
// exits, so a reused pid doesn't fool that check, and the socket file, which
// can outlive the process, is only a fallback.
// Both are sync so the feed snapshot can include them without promises.

export function sessionAlive(session: Session | null): boolean {
  if (!session) return false
  switch (session.harness) {
    case "claude": {
      const pid = basename(session.socket).match(/^(\d+)\.sock$/)?.[1]
      return pid ? claudeRunning(pid) : exists(session.socket)
    }
    case "codex":
      return session.pid === null || processRunning(session.pid)
    case "opencode":
      return opencodeRunning()
  }
}

export function agentAlive(agent: Agent, claudeSessions = claudeSessionsDir()): boolean {
  switch (agent.harness) {
    case "claude":
      return agent.pid !== null && claudeRunning(agent.pid, claudeSessions)
    case "codex":
      return agent.pid !== null && processRunning(agent.pid)
    case "opencode":
      return opencodeRunning()
  }
}

const claudeRunning = (pid: number | string, dir = claudeSessionsDir()) =>
  exists(join(dir, `${pid}.json`))

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

export async function postToSession(session: Session, text: string): Promise<void> {
  switch (session.harness) {
    case "claude":
      return await postToClaude(session, text)
    case "codex": {
      // Exits nonzero when no running TUI has the thread
      const queued = await run(
        "codex",
        ["queue", "--thread", session.thread, "--message", text],
        { timeout: 10_000 },
      )
      if (!queued.success) throw new Error(`codex queue: ${queued.stderr.trim()}`)
      return
    }
    case "opencode":
      return await postToOpencode(session.id, text)
  }
}

async function postToClaude(
  session: Extract<Session, { harness: "claude" }>,
  text: string,
): Promise<void> {
  const lines: string[] = []
  if (session.token) lines.push(JSON.stringify({ type: "auth", token: session.token }))
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }))
  // Open only once the message is ready: the session drops connections that
  // go 30s without a complete line. The session closes right after reading
  // the line, but the timeout bounds the wait in case it ever doesn't, since
  // delivery holds up the comment POST. A timeout counts as not delivered: the
  // comment waits in the log for the session to catch up on.
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(session.socket)
    conn.setTimeout(2000, () =>
      conn.destroy(new Error("timed out waiting for the session to read the post")),
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
