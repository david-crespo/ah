// Which terminal a Codex or opencode session is in. Both run their sessions
// in one shared background server that every TUI is a client of: Codex's
// app-server daemon, opencode's service. So what runs there, Codex's hooks
// included, has the env of whichever shell started the server, not of the TUI
// a session is in: its GHOSTTY_TERMINAL_ID names some other pane, often one
// long closed. Nothing they report says which client it's for either (a
// Codex hook's input is session_id, turn_id, cwd, transcript_path, model and
// the like). So the server looks at the TUI processes instead: each has its
// own pane's GHOSTTY_TERMINAL_ID, exported by .zshrc, and a cwd to match the
// session's against.

import { run } from "../../host/proc.ts"
import type { Snapshot } from "../dashboard/ghostty.ts"

export type TuiHarness = "codex" | "opencode"

export interface Tui {
  pid: number
  terminal: string
  cwd: string
}

interface Proc {
  pid: number
  ppid: number
  args: string
}

async function processTable(): Promise<Proc[]> {
  const { success, stdout } = await run("ps", ["-axo", "pid=,ppid=,args="])
  if (!success) return []
  return stdout.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }] : []
  })
}

const isDaemon = (args: string) => /(^|\/)codex app-server\b/.test(args)

/** Whether this process runs under Codex's app-server daemon, so its env
 * is the daemon's */
export async function underCodexDaemon(): Promise<boolean> {
  const procs = new Map((await processTable()).map((p) => [p.pid, p]))
  for (let pid = process.ppid; pid > 1;) {
    const proc = procs.get(pid)
    if (!proc) return false
    if (isDaemon(proc.args)) return true
    pid = proc.ppid
  }
  return false
}

/** An interactive TUI, run bare or with flags. Codex: its native binary,
 * or that resuming or forking a session; not the npm wrapper (node runs it),
 * the daemon, or one-shot subcommands like `exec` and `queue`. opencode: its
 * binary (opencode.exe when bun installs it), not `serve`, `run` and the
 * like. */
export function isTui(harness: TuiHarness, args: string): boolean {
  const [bin, sub] = args.split(/\s+/)
  if (sub === undefined || sub.startsWith("-")) return BINARY[harness].test(bin)
  return (
    harness === "codex" && BINARY.codex.test(bin) && (sub === "resume" || sub === "fork")
  )
}

const BINARY: Record<TuiHarness, RegExp> = {
  codex: /(^|\/)codex$/,
  opencode: /(^|\/)opencode(\.exe)?$/,
}

/** GHOSTTY_TERMINAL_ID from `ps -E` output, which appends the env to the
 * command line, space-separated */
export function terminalFromEnv(line: string): string | null {
  return line.match(/(?:^|\s)GHOSTTY_TERMINAL_ID=([0-9A-Fa-f-]+)(?=\s|$)/)?.[1] ?? null
}

/** Every running TUI of the harness that knows its terminal */
export async function readTuis(harness: TuiHarness): Promise<Tui[]> {
  const pids = (await processTable())
    .filter((p) => isTui(harness, p.args))
    .map((p) => p.pid)
  if (!pids.length) return []
  const list = pids.join(",")
  const [env, cwds] = await Promise.all([
    run("ps", ["-E", "-o", "pid=,command=", "-p", list]),
    run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", list]),
  ])
  // lsof -F prints a p<pid> line, then fields of that process: n<path>
  const cwdOf = new Map<number, string>()
  let pid = 0
  for (const line of cwds.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n")) cwdOf.set(pid, line.slice(1))
  }
  return env.stdout.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s/)
    const terminal = terminalFromEnv(line)
    const cwd = m && cwdOf.get(Number(m[1]))
    return m && terminal && cwd ? [{ pid: Number(m[1]), terminal, cwd }] : []
  })
}

/** The focused terminal of Ghostty's front window */
export function focusedTerminal(snapshot: Snapshot | null): string | null {
  const window = snapshot?.windows.find((w) => w.id === snapshot.front)
  return window?.tabs.find((t) => t.id === window.selectedTab)?.focused ?? null
}

/** The terminal of the TUI running a session in `cwd`: the one it was last
 * in if a TUI there still fits, else the only TUI in that directory, else
 * the focused one, since a prompt is typed where you're looking. null when
 * that leaves it open, e.g. two TUIs in one directory and the prompt came
 * in from ah to a session it hadn't placed. */
export function pickTerminal(
  cwd: string | null,
  tuis: Tui[],
  previous: string | null,
  focused: string | null,
  live: Set<string> | null,
): string | null {
  if (!cwd) return null
  const candidates = [
    ...new Set(
      tuis
        .filter((t) => t.cwd === cwd && (!live || live.has(t.terminal)))
        .map((t) => t.terminal),
    ),
  ]
  if (previous && candidates.includes(previous)) return previous
  if (candidates.length === 1) return candidates[0]
  if (focused && candidates.includes(focused)) return focused
  return null
}
