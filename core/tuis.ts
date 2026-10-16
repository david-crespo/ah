// Which block a Codex or opencode session is in. Both run their sessions
// in one shared background server that every TUI is a client of: Codex's
// app-server daemon, opencode's service. So what runs there, Codex's hooks
// included, has the env of whichever shell started the server, not of the TUI
// a session is in: its REX_BLOCK names some other pane, often one long
// closed. Nothing they report says which client it's for either (a Codex
// hook's input is session_id, turn_id, cwd, transcript_path, model and the
// like). So the server looks at the TUI processes instead, and the cwd of
// each to match the session's against. A TUI's pane is the block whose
// foreground process group it's in: Codex's TUI is a child of its npm
// wrapper, so its own pid isn't the foreground one, but its group is. A TUI
// suspended in the background isn't found.

import { ancestors, type Proc, processTable } from "../platform/proc.ts"
import type { RexState } from "./model.ts"
import { foregroundBlocks } from "../platform/rex.ts"

export type TuiHarness = "codex" | "opencode"

export interface Tui {
  pid: number
  block: string
  cwd: string
}

const isDaemon = (args: string) => /(^|\/)codex app-server\b/.test(args)

/** Whether this process runs under Codex's app-server daemon, so its env
 * is the daemon's */
export function underCodexDaemon(): boolean {
  return ancestors(processTable()).some((p) => isDaemon(p.args))
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

/** Every running TUI of the harness in the foreground of a block */
export function readTuis(harness: TuiHarness): Tui[] {
  const procs = processTable().filter((p) => isTui(harness, p.args))
  return tuisInBlocks(procs, foregroundBlocks())
}

/** The TUIs running in the foreground of a Rex block, given each block's
 * foreground process group by leader pid. The cwd is the leader's, which for
 * Codex is its wrapper's, the same as the TUI's. */
export function tuisInBlocks(
  procs: Proc[],
  foreground: Map<number, { block: string; cwd: string }>,
): Tui[] {
  return procs.flatMap((p) => {
    const fg = foreground.get(p.pgid)
    return fg?.cwd ? [{ pid: p.pid, block: fg.block, cwd: fg.cwd }] : []
  })
}

/** The focused block of the front session */
export function focusedBlock(rex: RexState | null): string | null {
  const session = rex?.sessions.find((s) => s.id === rex.front)
  return session?.tabs.find((t) => t.id === session.selectedTab)?.focused ?? null
}

/** The block of the TUI running a session in `cwd`: the one it was last
 * in if a TUI there still fits, else the only TUI in that directory, else
 * the focused one, since a prompt is typed where you're looking. null when
 * that leaves it open, e.g. two TUIs in one directory and the prompt came
 * in from ah to a session it hadn't placed. */
export function pickBlock(
  cwd: string | null,
  tuis: Tui[],
  previous: string | null,
  focused: string | null,
  live: Set<string> | null,
): string | null {
  if (!cwd) return null
  const candidates = [
    ...new Set(
      tuis.filter((t) => t.cwd === cwd && (!live || live.has(t.block))).map((t) => t.block),
    ),
  ]
  if (previous && candidates.includes(previous)) return previous
  if (candidates.length === 1) return candidates[0]
  if (focused && candidates.includes(focused)) return focused
  return null
}
