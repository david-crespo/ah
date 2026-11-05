// A stack page's diff buttons (stack.ts) open the diff in skepsis, a diff
// review whose comments go to the agent the page is bound to. AH_SKEPSIS is
// the command that runs it, split on spaces, like
// `node /Users/me/skepsis/cli.ts`; without it, skepsis on PATH. Each diff
// gets one skepsis, kept running while the server is, and a later click on
// the same diff shows its page again.

import { type ChildProcess, spawn } from "node:child_process"
import type { AgentId } from "../../core/model.ts"
import { isRecord } from "../../platform/guards.ts"
import { showUrl } from "../../platform/window.ts"

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

const running = new Map<string, Promise<string>>()
const children = new Set<ChildProcess>()
process.on("exit", () => {
  for (const child of children) child.kill()
})

/** Show the diff in skepsis, run in `cwd`, starting it unless it's running */
export async function openSkepsis(cwd: string, diff: string[], agent: AgentId | null) {
  const args = [
    ...command.slice(1),
    ...diff,
    ...(agent ? ["--send", sendCommand(agent)] : []),
    "--no-open",
  ]
  const key = JSON.stringify([cwd, args])
  let url = running.get(key)
  if (!url) {
    url = start(args, cwd, () => running.delete(key))
    running.set(key, url)
  }
  await showUrl("window", await url, { name: "skepsis", badge: "S", color: "#475569" })
}

/** Run skepsis, resolving with its page's URL once it's listening */
function start(args: string[], cwd: string, gone: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    children.add(child)
    // Its output up to the line with the URL, and then nothing
    let out: string | null = ""
    let err = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (out === null) return
      out += chunk
      const url = out.match(/^skepsis on (\S+)/m)?.[1]
      if (url) {
        out = null
        resolve(url)
      }
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err = (err + chunk).slice(-2000)
    })
    const end = (e: Error) => {
      children.delete(child)
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
}
