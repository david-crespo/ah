// `ah hook agent` and `ah hook shell`: how agents and zsh report into the session
// registry. Each reads what it's told, posts one event to the server, and
// exits. Neither may break what called it: an agent waits on its hooks, and
// a hook's stdout on SessionStart or UserPromptSubmit becomes context for
// Claude, so they always exit 0, give up after a short wait rather than hold
// up a prompt while ah is down, and print nothing but what the server
// answers: on SessionStart, the workspace's active trackers, and on
// UserPromptSubmit, what changed since the agent was last told
// (notices.ts). Trackers belong to the workspace, so they're there after
// /clear, /new, compaction, or a restart, and the new session would
// otherwise start without them.
//
//   claude/settings.json, codex/hooks.json:  ah hook agent --harness <name>
//     on SessionStart, UserPromptSubmit, Stop, SessionEnd, with the hook's
//     JSON on stdin (hook_event_name, session_id, cwd, prompt,
//     transcript_path; Codex sends the same keys)
//   .zshrc, at startup and on chpwd:         ah hook shell <label>
//
// The block is REX_BLOCK, which Rex sets in every shell and so every
// agent run from it. A session's label is its block's shell label, which
// the registry has from `shell`, or failing that its directory's.
// Except for Codex hooks run by its shared daemon, whose env belongs to
// another shell: the server finds those sessions' blocks (tuis.ts).

import { Command, Option } from "@commander-js/extra-typings"
import { homedir } from "node:os"
import { portOption } from "../platform/cli.ts"
import { isOneOf, str } from "../platform/guards.ts"
import { ensureServer } from "../platform/server.ts"
import { currentAgent, currentAddress } from "../platform/session.ts"
import { underCodexDaemon } from "./tuis.ts"
import { type Address, HARNESSES, type Harness } from "./model.ts"
import { HOOK_EVENTS, type RegistryEvent } from "./registry.ts"
import { sanitizeTitle } from "./summary.ts"

/** The block a process was started in, from its env */
const envBlock = (env: NodeJS.ProcessEnv) => env.REX_BLOCK || null

/** ~/repos/ah → ah, ~/x → ~/x: a session's label when there's no shell label */
export function abbreviatePath(path: string, home = homedir()): string {
  for (const dir of ["repos", "oxide", "jj-workspaces"]) {
    const prefix = `${home}/${dir}/`
    if (path.startsWith(prefix)) return path.slice(prefix.length)
  }
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** An event, and where the agent can be reached now, which the server keeps
 * apart from the event */
type Report = RegistryEvent & { address?: Address | null }

const post = (port: number, event: Report, timeoutMs: number) =>
  fetch(`http://127.0.0.1:${port}/core/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(timeoutMs),
  })

/** What the server answers an event with */
export interface EventReply {
  /** What to tell the agent, if anything */
  context: string | null
}

/** Post, starting the server if nothing answers. Failures go to stderr,
 * which agents don't show for a hook that exits 0. */
async function send(port: number, event: Report): Promise<EventReply | null> {
  try {
    const res = await post(port, event, 1000).catch(async () => {
      await ensureServer(port)
      return post(port, event, 1000)
    })
    if (!res.ok) {
      console.error(`ah: event refused: ${res.status} ${await res.text()}`)
      return null
    }
    return res.status === 204 ? null : ((await res.json()) as EventReply)
  } catch (e) {
    console.error(`ah: couldn't post the event: ${e}`)
    return null
  }
}

async function readStdin(): Promise<string> {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}

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
    block: envBlock(env),
    // Filled in by the command, which can look for the process
    process: null,
    label: sanitizeTitle(cwd ? abbreviatePath(cwd) : ""),
    cwd,
    prompt: str(raw.prompt) ?? undefined,
    transcript: str(raw.transcript_path) ?? undefined,
  }
}

const agent = new Command("agent")
  .summary("Report an agent hook event to ah")
  .description("Report an agent hook event to ah. Reads the hook's JSON from stdin.")
  .addOption(
    new Option("--harness <name>", "The agent the hook is from")
      .choices(HARNESSES)
      .default("claude" as const),
  )
  .addOption(portOption())
  .action(async ({ harness, port }) => {
    // Under Codex's daemon the env is the daemon's: leave the block and
    // label to the server (tuis.ts)
    const daemon = harness === "codex" && underCodexDaemon()
    const event = hookEvent(await readStdin(), harness, daemon ? {} : process.env)
    if (event?.kind !== "hook") return
    // Outside Rex the agent is its process. Finding Codex's takes a ps, so
    // only then.
    if (!event.block && !daemon) event.process = currentAgent()?.process ?? null
    // Claude's inbox socket, so a page bound to the agent reaches a new
    // process in its pane. Codex and opencode are reached by their session.
    const address = harness === "claude" ? currentAddress() : null
    const reply = await send(port, { ...event, address })
    // Only these two events' output reaches the agent
    const told = event.event === "SessionStart" || event.event === "UserPromptSubmit"
    if (told && reply?.context) console.log(reply.context)
  })

const shell = new Command("shell")
  .summary("Report a shell's directory label")
  .description(
    "Report a shell's directory label, which the tab title shows. Once the shell changes directory, its pane stops showing the last agent that ran in it.",
  )
  .argument("<label>", "What the shell calls its directory")
  .addOption(portOption())
  .action(async (label, { port }) => {
    const block = envBlock(process.env)
    const clean = sanitizeTitle(label)
    if (block && clean) await send(port, { kind: "shell", block, label: clean })
  })

export const hook = new Command("hook")
  .description("Commands for use in agent and shell hooks")
  .addCommand(agent)
  .addCommand(shell)
