// Running a command to completion and collecting its output, which is most of
// what ah does with subprocesses, and reading the process table. Long-lived
// children (`rex events`, the detached server) use node:child_process
// directly.

import { execFile, type ExecFileOptions, execFileSync } from "node:child_process"
import { basename } from "node:path"

export interface Output {
  success: boolean
  /** null when the process died from a signal */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run `cmd` and wait for it. Never throws for a nonzero exit, only when the
 * command can't be started at all (e.g. it isn't on PATH).
 */
export function run(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") return reject(error) // ENOENT etc.
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0
        resolve({ success: !error, code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  args: string
}

/** Every process. Empty when `ps` can't run, as in Codex's sandbox. Sync,
 * since it takes a few ms and its callers are otherwise sync too. */
export function processTable(): Proc[] {
  let table: string
  try {
    table = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,args="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return []
  }
  return table.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    return m
      ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] }]
      : []
  })
}

/** The processes above this one, nearest first */
export function ancestors(table: Proc[]): Proc[] {
  const procs = new Map(table.map((p) => [p.pid, p]))
  const found: Proc[] = []
  for (let pid = process.ppid; pid > 1;) {
    const proc = procs.get(pid)
    if (!proc) break
    found.push(proc)
    pid = proc.ppid
  }
  return found
}

/** The file name of what a process runs, as `ps -o comm=` shows it less the
 * directory */
export const command = (args: string) => basename(args.split(/\s+/)[0])
