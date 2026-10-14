// `ah app sessions hook` and `shell`: how agents and zsh report into the session
// registry. Each reads what it's told, posts one event to the server, and
// exits. Neither may break what called it: an agent waits on its hooks, and
// a hook's stdout on SessionStart or UserPromptSubmit becomes context for
// Claude, so they always exit 0, give up after a short wait rather than hold
// up a prompt while ah is down, and print nothing but one thing: on
// SessionStart, the session's file in the dashboard. That record belongs to
// the agent's process, so it's only there after /clear, /new, or compaction,
// and the new session would otherwise start without its tracker.
//
//   claude/settings.json, codex/hooks.json:  ah app sessions hook --harness <name>
//     on SessionStart, UserPromptSubmit, Stop, SessionEnd, with the hook's
//     JSON on stdin (hook_event_name, session_id, cwd, prompt,
//     transcript_path; Codex sends the same keys)
//   .zshrc, at startup and on chpwd:         ah app sessions shell <label>
//
// The terminal is REX_BLOCK, which Rex sets in every shell and so every
// agent run from it. A session's label is its terminal's shell label, which
// the registry has from `shell`, or failing that its directory's.
// Except for Codex hooks run by its shared daemon, whose env belongs to
// another shell: the server finds those sessions' terminals (tuis.ts).

import { Command, Option } from "@commander-js/extra-typings"
import { homedir } from "node:os"
import { portOption } from "../../host/cli.ts"
import { isOneOf } from "../../host/guards.ts"
import { ensureServer } from "../../host/server.ts"
import { currentAgent } from "../../host/session.ts"
import { sessionFile } from "../dashboard/api.ts"
import { underCodexDaemon } from "./tuis.ts"
import { HARNESSES, HOOK_EVENTS, type Harness, type RegistryEvent } from "./registry.ts"
import { sanitizeTitle } from "./summary.ts"

/** The terminal pane a process was started in, from its env */
export const terminalOf = (env: NodeJS.ProcessEnv) => env.REX_BLOCK || null

/** ~/repos/ah → ah, ~/x → ~/x: a session's label when there's no shell label */
export function abbreviatePath(path: string, home = homedir()): string {
  for (const dir of ["repos", "oxide", "jj-workspaces"]) {
    const prefix = `${home}/${dir}/`
    if (path.startsWith(prefix)) return path.slice(prefix.length)
  }
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const post = (port: number, event: RegistryEvent, timeoutMs: number) =>
  fetch(`http://127.0.0.1:${port}/app/sessions/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(timeoutMs),
  })

/** Post, starting the server if nothing answers. Failures go to stderr,
 * which agents don't show for a hook that exits 0. */
async function send(port: number, event: RegistryEvent) {
  try {
    const res = await post(port, event, 1000).catch(async () => {
      await ensureServer(port)
      return post(port, event, 1000)
    })
    if (!res.ok) console.error(`ah: event refused: ${res.status} ${await res.text()}`)
  } catch (e) {
    console.error(`ah: couldn't post the event: ${e}`)
  }
}

async function readStdin(): Promise<string> {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null)

export function hookEvent(
  input: string,
  harness: Harness,
  env = process.env,
): RegistryEvent | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(input)
  } catch {
    return null
  }
  const event = raw.hook_event_name
  const session = str(raw.session_id)
  if (!isOneOf(HOOK_EVENTS, event) || !session) return null
  const cwd = str(raw.cwd)
  return {
    kind: "hook",
    event,
    harness,
    session,
    terminal: terminalOf(env),
    label: sanitizeTitle(cwd ? abbreviatePath(cwd) : ""),
    cwd,
    prompt: str(raw.prompt) ?? undefined,
    transcript: str(raw.transcript_path) ?? undefined,
  }
}

/** What a starting session is told about the file it inherited */
export const startContext = (file: string) =>
  `This session's tracker (its file in the ah dashboard, kept across /clear or ` +
  `compaction) is ${file}. Check it when picking up work, and keep it updated.`

export const hook = new Command("hook")
  .description("Report an agent hook (its JSON on stdin) to the session registry")
  .addOption(
    new Option("--harness <name>", "The agent the hook is from")
      .choices(HARNESSES)
      .default("claude" as const),
  )
  .addOption(portOption())
  .action(async ({ harness, port }) => {
    // Under Codex's daemon the env is the daemon's: leave the terminal and
    // label to the server (tuis.ts)
    const daemon = harness === "codex" && underCodexDaemon()
    const event = hookEvent(await readStdin(), harness, daemon ? {} : process.env)
    if (!event) return
    if (event.kind === "hook" && event.event === "SessionStart" && !daemon) {
      try {
        const agent = currentAgent()
        const file = agent && sessionFile(agent)
        if (file) console.log(startContext(file))
      } catch (e) {
        console.error(`ah: couldn't look up the session's file: ${e}`)
      }
    }
    await send(port, event)
  })

export const shell = new Command("shell")
  .description("Report a shell's directory label, which drops its terminal's session")
  .argument("<label>", "What the shell calls its directory")
  .addOption(portOption())
  .action(async (label, { port }) => {
    const terminal = terminalOf(process.env)
    const clean = sanitizeTitle(label)
    if (terminal && clean) await send(port, { kind: "shell", terminal, label: clean })
  })
