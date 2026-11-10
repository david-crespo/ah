// A stack page's diff buttons (client.ts) open the diff in skepsis, a diff
// review whose comments go to the agent the page is bound to. AH_SKEPSIS is
// the command that runs it, split on spaces, like
// `node /Users/me/skepsis/cli.ts`; without it, skepsis on PATH. Each diff
// gets one skepsis, kept running while its window is open, and a later click
// on the same diff shows its page again.

import { type ChildProcess, spawn } from "node:child_process"
import type { AgentId } from "../../core/model.ts"
import { isRecord } from "../../platform/guards.ts"
import { showUrl, windowsShowing } from "../../platform/window.ts"

const command = (process.env.AH_SKEPSIS || "skepsis").trim().split(/\s+/)

/** skepsis's arguments for the diff a page asks for: { rev } for one
 * revision, { from, to } for a range. Null for anything else, or a revision
 * starting with "-", which skepsis would take for a flag. */
export function diffArgs(body: unknown): string[] | null {
  const rev = (v: unknown): v is string =>
    typeof v === "string" && /^[^-\s][^\s]{0,199}$/.test(v)
  if (!isRecord(body)) return null
  if (rev(body.rev)) return ["-r", body.rev]
  if (rev(body.from) && rev(body.to)) return ["--from", body.from, "--to", body.to]
  return null
}

/** The command skepsis runs for its Send button: the comment to `agent` */
export const sendCommand = (agent: AgentId) =>
  `jq -r .prompt | ah message send --agent '${agent.replaceAll("'", `'\\''`)}'`

/** A skepsis: its process, its page's URL once it's listening, and when
 * its window was last opened */
type Running = { child: ChildProcess; listening: Promise<string>; url?: string; at: number }

const running = new Map<string, Running>()
process.on("exit", () => {
  for (const { child } of running.values()) child.kill()
})

/** How long skepsis has to say where it's listening */
const START_TIMEOUT = 15_000
/** How long a window can take to show up in the process table */
const WINDOW_GRACE = 10_000

/** Show the diff in skepsis, run in `cwd`, starting it unless it's running */
export async function openSkepsis(cwd: string, diff: string[], agent: AgentId | null) {
  const args = [
    ...command.slice(1),
    ...diff,
    ...(agent ? ["--send", sendCommand(agent)] : []),
    "--no-open",
  ]
  reap()
  const key = JSON.stringify([cwd, args])
  let skepsis = running.get(key)
  if (!skepsis) {
    // Unless it was reaped, and another has taken its place
    const started = start(args, cwd, () => {
      if (running.get(key) === started) running.delete(key)
    })
    running.set(key, (skepsis = started))
  }
  const url = await skepsis.listening
  await showUrl("window", url, { name: "skepsis", badge: "S", color: "#475569" }, true)
  skepsis.url = url
  skepsis.at = Date.now()
}

/** Stop each skepsis whose window has been closed, so a day of diffs leaves
 * only the ones still open. Run at each click, which is when more start. */
export function reap(now = Date.now()) {
  for (const [key, { child, url, at }] of running) {
    if (!url || now - at <= WINDOW_GRACE || windowsShowing(url).length) continue
    // Forgotten now, not when it exits, so a click on its diff starts another
    running.delete(key)
    child.kill()
  }
}

/** Run skepsis; `listening` resolves with its page's URL */
function start(args: string[], cwd: string, gone: () => void): Running {
  const child = spawn(command[0], args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  const listening = new Promise<string>((resolve, reject) => {
    // Its output up to the line with the URL, and then nothing
    let out: string | null = ""
    let err = ""
    const timer = setTimeout(() => {
      err = `skepsis didn't start in ${START_TIMEOUT / 1000}s`
      child.kill()
    }, START_TIMEOUT)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (out === null) return
      out += chunk
      const url = out.match(/^skepsis on (\S+)/m)?.[1]
      if (url) {
        out = null
        clearTimeout(timer)
        resolve(url)
      }
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err = (err + chunk).slice(-2000)
    })
    const end = (e: Error) => {
      clearTimeout(timer)
      gone()
      reject(e)
    }
    child.on("error", (e: NodeJS.ErrnoException) =>
      end(
        e.code === "ENOENT"
          ? new Error(
              `${command[0]} not found: set AH_SKEPSIS to the command that runs skepsis`,
            )
          : e,
      ),
    )
    child.on("exit", (code) => end(new Error(err.trim() || `skepsis exited with ${code}`)))
  })
  // Rejected for whoever asked; a later exit has no one to tell
  listening.catch(() => {})
  return { child, listening, at: Date.now() }
}
