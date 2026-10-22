// A message from a tool in a Rex pane, like the user's editor or a diff
// review, to an agent in its tab (`ah message send`). ah only routes the
// message, and holds it while no agent is there (core.ts).

import { callServer, die, ensureStarted, serverUrl } from "../platform/cli.ts"
import { agentLine, agentsNear } from "../subjects/files/cli.ts"

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
