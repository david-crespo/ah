// The agents in a Rex tab, for a command run in one of its panes: listing
// them, picking the one a file is bound to, and sending one a message from
// a tool like the user's editor or a diff review (`ah message send`). ah
// only routes the message, and holds it while no agent is there (core.ts).

import { styleText } from "node:util"
import select from "@inquirer/select"
import { callServer, die, ensureStarted, serverUrl } from "./shared.ts"
import type { AgentId, NearbyAgent } from "../model.ts"

/** A nearby agent as its tab's title has it */
const agentLine = (a: NearbyAgent) =>
  [a.label, a.summary].filter(Boolean).join(" | ") +
  ` (${a.harness}${a.busy ? ", working" : ""})`

/** The live agents in the Rex tab of `block`, in its layout order */
export async function agentsNear(port: number, block: string): Promise<NearbyAgent[]> {
  return await callServer<NearbyAgent[]>(
    serverUrl(port, `core/agents-near?block=${encodeURIComponent(block)}`),
  )
}

/** Make `agent` the one the shell in `block` sends to from now on */
async function pickAgent(port: number, block: string, agent: AgentId) {
  await callServer(serverUrl(port, "core/pick"), { body: { block, agent } })
}

/** From a shell in no agent session: the agent its comments go to (its
 * pick, or its Rex tab's only agent), or else the one the user picks, which
 * becomes the pane's pick; null with no agent in its tab. Picking takes a
 * terminal, so without one, several is an error. */
export async function pickAgentNear(port: number): Promise<AgentId | null> {
  const block = process.env.REX_BLOCK
  if (!block) return null
  const agents = await agentsNear(port, block)
  const target = agents.find((a) => a.target)
  if (target) console.error(`ah: comments go to ${agentLine(target)}`)
  if (target || !agents.length) return target?.id ?? null
  if (!process.stdin.isTTY) {
    const list = agents.map((a) => `  ${agentLine(a)}`).join("\n")
    die(`ah: this tab has ${agents.length} agents; run in a terminal to pick one:\n${list}`)
  }
  // q quits, which select has no key for
  const quit = new AbortController()
  const onKey = (_: string, key?: { name?: string }) => {
    if (key?.name === "q") quit.abort()
  }
  process.stdin.on("keypress", onKey)
  try {
    const picked = await select(
      {
        message: "Which agent gets comments?",
        choices: agents.map((a) => ({ name: agentLine(a), value: a.id })),
        theme: {
          // j and k move too
          keybindings: ["vim"],
          style: {
            keysHelpTip: (keys: [string, string][]) =>
              [...keys, ["q", "quit"]]
                .map(([k, action]) => `${styleText("bold", k)} ${styleText("dim", action)}`)
                .join(styleText("dim", " • ")),
          },
        },
      },
      // stdout is for the page's URL
      { output: process.stderr, signal: quit.signal },
    )
    await pickAgent(port, block, picked)
    return picked
  } catch (e) {
    // q, Ctrl+C, or Ctrl+D
    if (e instanceof Error && ["AbortPromptError", "ExitPromptError"].includes(e.name)) {
      die("ah: no agent picked, nothing shown")
    }
    throw e
  } finally {
    process.stdin.off("keypress", onKey)
  }
}

/** Send text to agent, or else to the agent a send from block goes to, and
 * say whether it took it or it's held for the next one in the tab. With
 * several agents in the tab and none picked, refuse and list them. */
export async function sendToTab(
  port: number,
  block: string | null,
  agent: string | null,
  text: string,
): Promise<"sent" | "held"> {
  await ensureStarted(port)
  if (block && !agent) {
    const agents = await agentsNear(port, block)
    if (agents.length > 1 && !agents.some((a) => a.target)) {
      const list = agents.map((a) => `  ${a.id}\t${agentLine(a)}`).join("\n")
      die(
        `ah: this tab has ${agents.length} agents; pass --agent <id> with one of:\n${list}`,
      )
    }
  }
  const { status } = await callServer<{ status: "sent" | "held" }>(
    serverUrl(port, "core/send"),
    { body: { block, agent, text } },
  )
  return status
}
