// Agent sessions in one shape across harnesses, and where they are in
// Ghostty. Two sources: ah's hook-fed registry (registry.ts), which covers
// every harness with hooks and knows each session's terminal, and Claude's
// own registry, ~/.claude/sessions/<pid>.json, which exists only while the
// process runs and has its inbox socket. Sessions imported from
// ghostty-tab-title (which ah replaced) don't say which harness they belong
// to, so that comes from where the transcript is, or failing that the id's
// format (Codex ids are UUIDv7, Claude's v4).

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Snapshot } from "../dashboard/ghostty.ts"
import type { Harness, Registry } from "./registry.ts"

export interface ClaudeProcess {
  pid: number
  sessionId: string
  cwd: string
  /** "busy" or "idle" */
  status: string
  socket: string | null
}

export interface AgentSession {
  id: string
  harness: Harness | null
  /** How `harness` was decided: its hooks, the running process's registry
   * entry, a transcript on disk, or only the id's format */
  harnessFrom: "hook" | "registry" | "transcript" | "id" | null
  label: string
  cwd: string | null
  busy: boolean
  summary: string | null
  /** The terminal it's shown in: null once another session or a cd in that
   * terminal took it over, or for a session whose hooks never said */
  terminal: string | null
  /** Where that terminal is now, or null if it's gone */
  place: { window: string; tab: string } | null
  /** Claude only, while the process runs */
  process: { pid: number; status: string; socket: string | null } | null
}

const home = homedir()

export async function readClaudeProcesses(): Promise<ClaudeProcess[]> {
  const dir = join(home, ".claude", "sessions")
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    /^\d+\.json$/.test(f),
  )
  const read = await Promise.all(
    files.map(async (f): Promise<ClaudeProcess | null> => {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), "utf8"))
        if (typeof raw.sessionId !== "string") return null
        return {
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          status: raw.status ?? "",
          socket: raw.messagingSocketPath ?? null,
        }
      } catch {
        return null
      }
    }),
  )
  return read.filter((p) => p !== null)
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** UUIDv7 has a 7 as the first digit of its third group */
const isUuidV7 = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)

/**
 * Which harness a session id belongs to, by looking for its transcript:
 * Claude's at ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl, Codex's
 * at ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Found answers are
 * cached for good; the Codex index is rebuilt on a miss, at most every 30s.
 */
export class Harnesses {
  #known = new Map<string, Harness>()
  #codexIds = new Set<string>()
  #codexIndexedAt = 0

  async #indexCodex() {
    if (Date.now() - this.#codexIndexedAt < 30_000) return
    this.#codexIndexedAt = Date.now()
    const files = await readdir(join(home, ".codex", "sessions"), {
      recursive: true,
    }).catch(() => [] as string[])
    for (const f of files) {
      const id = basename(f).match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1]
      if (id) this.#codexIds.add(id)
    }
  }

  async fromTranscript(id: string, cwd: string | null): Promise<Harness | null> {
    const known = this.#known.get(id)
    if (known) return known
    let found: Harness | null = null
    if (
      cwd &&
      (await exists(
        join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${id}.jsonl`),
      ))
    ) {
      found = "claude"
    } else {
      if (!this.#codexIds.has(id)) await this.#indexCodex()
      if (this.#codexIds.has(id)) found = "codex"
    }
    if (found) this.#known.set(id, found)
    return found
  }
}

/** Every session in the registry, plus running Claude sessions it doesn't have */
export async function listSessions(
  registry: Registry,
  processes: ClaudeProcess[],
  snapshot: Snapshot | null,
  harnesses: Harnesses,
): Promise<AgentSession[]> {
  const places = new Map<string, { window: string; tab: string }>()
  for (const w of snapshot?.windows ?? []) {
    for (const t of w.tabs) {
      for (const term of t.terminals) places.set(term.id, { window: w.id, tab: t.id })
    }
  }
  const byId = new Map(processes.map((p) => [p.sessionId, p]))
  const shownIn = new Map([...registry.visible].map(([terminal, id]) => [id, terminal]))

  const ids = new Set([...registry.sessions.keys(), ...byId.keys()])
  return Promise.all(
    [...ids].map(async (id): Promise<AgentSession> => {
      const g = registry.sessions.get(id)
      const p = byId.get(id)
      const cwd = g?.cwd ?? p?.cwd ?? null
      const hooked = g?.harness ?? null
      const transcript = hooked || p ? null : await harnesses.fromTranscript(id, cwd)
      const harness: Harness | null =
        hooked ?? (p ? "claude" : (transcript ?? (isUuidV7(id) ? "codex" : null)))
      const harnessFrom = hooked
        ? "hook"
        : p
          ? "registry"
          : transcript
            ? "transcript"
            : harness
              ? "id"
              : null
      const terminal = shownIn.get(id) ?? null
      return {
        id,
        harness,
        harnessFrom,
        label: g?.label ?? (cwd ? basename(cwd) : ""),
        cwd,
        busy: g ? g.state !== "" : p?.status === "busy",
        summary: g?.summary ?? null,
        terminal,
        place: terminal ? (places.get(terminal) ?? null) : null,
        process: p ? { pid: p.pid, status: p.status, socket: p.socket } : null,
      }
    }),
  )
}
