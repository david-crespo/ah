// Starting and stopping `ah serve`, the foreground server process. There's no
// LaunchAgent: commands that need the server call ensureServer, which starts
// one detached if nothing answers, so it outlives the agent's Bash command and
// the session. The server writes its pid to a file so `ah stop` can kill it
// even when it's too hung to answer.

import { spawn } from "node:child_process"
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isRecord } from "./guards.ts"
import { ahStateDir } from "./paths.ts"
import { run } from "./proc.ts"

export interface ServerFiles {
  pid: string
  log: string
}

export function defaultFiles(): ServerFiles {
  const dir = ahStateDir()
  return { pid: join(dir, "serve.pid"), log: join(dir, "serve.log") }
}

export interface Status {
  pid: number
  pages: number
}

/** What the server on this port says about itself, or null if nothing
 * answers, or something other than ah does */
export async function status(port: number, timeoutMs = 1000): Promise<Status | null> {
  let body: unknown
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    body = await res.json()
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  const { pid, pages } = body
  return typeof pid === "number" && typeof pages === "number" ? { pid, pages } : null
}

/** Called by the server once it's listening; removes the file again on exit */
export function writePidFile(files: ServerFiles, port: number) {
  mkdirSync(join(files.pid, ".."), { recursive: true })
  writeFileSync(files.pid, JSON.stringify({ pid: process.pid, port }) + "\n")
  const cleanup = () => {
    if (readPidFile(files)?.pid === process.pid) rmSync(files.pid)
    process.exit(0)
  }
  process.on("SIGTERM", cleanup)
  process.on("SIGINT", cleanup)
}

function readPidFile(files: ServerFiles): { pid: number; port: number } | null {
  let body: unknown
  try {
    body = JSON.parse(readFileSync(files.pid, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  const { pid, port } = body
  return typeof pid === "number" && typeof port === "number" ? { pid, port } : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Start `ah serve` on the port unless something already answers there, by
 * running this same script again with its output going to the log. Returns
 * the running server's pid if there was one, else null.
 */
export async function ensureServer(
  port: number,
  files = defaultFiles(),
): Promise<number | null> {
  const running = await status(port)
  if (running) return running.pid
  mkdirSync(join(files.log, ".."), { recursive: true })
  const log = openSync(files.log, "a")
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], "serve", "--port", String(port)],
    { stdio: ["ignore", log, log], detached: true },
  )
  child.unref()
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (await status(port, 200)) {
      console.error(`ah: started the server (log: ${files.log})`)
      return null
    }
    await sleep(100)
  }
  console.error(`ah: started the server but it isn't answering; see ${files.log}`)
  process.exit(1)
}

/** Whether the process is a running `ah serve`, so a stale pid file can't
 * make us kill some unrelated process that reused the pid */
async function isAhServe(pid: number): Promise<boolean> {
  const { success, stdout } = await run("ps", ["-p", String(pid), "-o", "command="])
  // ah from PATH, ah.ts from source, or dist/ah.js from the package
  return success && /\bah(\.[jt]s)? serve\b/.test(stdout)
}

function kill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

/** Stop the server: ask it for its pid, else read the pid file. Returns what
 * happened, for printing. */
export async function stopServer(port: number, files = defaultFiles()): Promise<string> {
  const answering = await status(port)
  const fromFile = readPidFile(files)
  const pid = answering?.pid ?? (fromFile?.port === port ? fromFile.pid : undefined)
  if (pid === undefined) {
    return answering
      ? `a server from before ah stop is on port ${port}; stop it by hand (lsof -i :${port})`
      : "not running"
  }
  if (!answering && !(await isAhServe(pid))) {
    rmSync(files.pid)
    return "not running (removed a stale pid file)"
  }
  kill(pid, "SIGTERM")
  for (let waited = 0; waited < 3000; waited += 100) {
    await sleep(100)
    if (!(await isAhServe(pid))) return `stopped (pid ${pid})`
  }
  kill(pid, "SIGKILL")
  return `killed (pid ${pid}), it didn't exit on SIGTERM`
}
