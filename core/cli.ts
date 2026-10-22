// `ah workspace` and `ah debug agents`, which read the registry as the
// server last saved it, so they work with the server down, except
// `ah workspace agents`, which asks the server.

import { Command } from "@commander-js/extra-typings"
import { resolve } from "node:path"
import type { RexState, Tab, WorkspaceRoot } from "./model.ts"
import { die, ensureStarted, portOption } from "../platform/cli.ts"
import { agentsNear } from "../subjects/files/cli.ts"
import { readRex } from "../platform/rex.ts"
import { blockOf, emptyRegistry, loadRegistry } from "./registry.ts"
import { rootFinder, tabRoot } from "./workspace.ts"
import { isCurrent } from "./core.ts"
import { listAgents, readClaudeProcesses } from "./agent_view.ts"

/** `ah debug agents` */
export const debugAgents = new Command("agents")
  .summary("List the agents ah knows about")
  .description(
    "List agents that are in a Rex pane or still running, as reported by agent hooks and Claude.",
  )
  .option("-a, --all", "Include agents no longer in a block or running")
  .option("--json", "Print JSON")
  .action(async ({ all, json }) => {
    // Without Rex there are no tabs, only agents
    const rex: RexState | null = await readRex().catch(() => null)
    const list = listAgents(
      loadRegistry() ?? emptyRegistry(),
      await readClaudeProcesses(),
      rex,
    ).filter((s) => all || isCurrent(s))
    if (json) return console.log(JSON.stringify(list, null, 2))
    for (const s of list.toSorted((a, b) => (a.tab ?? "").localeCompare(b.tab ?? ""))) {
      const where = s.tab ?? (s.block ? "gone" : "-")
      const proc = s.process ? `pid ${s.process.pid}` : ""
      const activity = [s.busy ? "🌀" : "", s.summary ?? ""].filter(Boolean).join(" ")
      const session = s.session.slice(0, 8)
      console.log([session, s.harness, where, s.label, proc, activity].join("\t"))
    }
  })

interface WorkspaceView {
  root: WorkspaceRoot
  /** The Rex tabs on it */
  tabs: { id: string; title: string }[]
  /** What the agent in those tabs that reported last is doing */
  summary: string | null
  /** Its current tracker */
  tracker: string | null
}

/** The workspaces with a tab open in Rex, from Rex and the registry as last
 * saved */
async function workspaces(): Promise<WorkspaceView[]> {
  const rex = await readRex().catch(() => null)
  if (!rex) return []
  const registry = loadRegistry() ?? emptyRegistry()
  const rootOf = rootFinder()
  const byRoot = new Map<WorkspaceRoot, Tab[]>()
  for (const tab of rex.sessions.flatMap((s) => s.tabs)) {
    const root = tabRoot(tab, rootOf)
    if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), tab])
  }
  const agents = [...registry.agents.values()].toSorted((a, b) => b.updatedAt - a.updatedAt)
  return [...byRoot].map(([root, tabs]) => {
    const blocks = new Set(tabs.flatMap((t) => t.blocks.map((b) => b.id)))
    const agent = agents.find((a) => a.summary && blocks.has(blockOf(a) ?? ""))
    return {
      root,
      tabs: tabs.map((t) => ({ id: t.id, title: t.name })),
      summary: agent?.summary ?? null,
      tracker: registry.trackers.get(root)?.current ?? null,
    }
  })
}

export const workspace = new Command("workspace")
  .description("jj workspaces and the Rex tabs and agents in them")
  .action(function () {
    this.help()
  })

workspace
  .command("ls")
  .summary("List workspaces with a tab open in Rex")
  .description(
    "List workspaces with a tab open in Rex, showing each one's root and what its agent is doing.",
  )
  .option("--json", "Print JSON, with each one's tabs and current tracker")
  .action(async ({ json }) => {
    const list = await workspaces()
    if (json) return console.log(JSON.stringify(list, null, 2))
    for (const w of list) console.log([w.root, w.summary ?? ""].join("\t"))
  })

workspace
  .command("show")
  .summary("Show the workspace a directory is in")
  .description(
    "Print the workspace a directory is in, as JSON, if a Rex tab is open on it.",
  )
  .argument("[path]", "A directory in it", ".")
  .action(async (path) => {
    const root = rootFinder()(resolve(path))
    if (!root) die(`ah: ${path} isn't in a jj workspace`)
    const found = (await workspaces()).find((w) => w.root === root)
    if (!found) die(`ah: no tab open on ${root}`)
    console.log(JSON.stringify(found, null, 2))
  })

workspace
  .command("agents")
  .summary("List the agents a send from this Rex pane can go to")
  .description(
    "List the live agents in this Rex pane's tab, in layout order, one JSON line each, for an editor to show where `ah message send` goes or to pick from. `target` is true on the one a send without --agent goes to: the pane's pick (the last --agent sent from it, while it's in the tab) or the tab's only agent. Prints nothing outside Rex.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    const block = process.env.REX_BLOCK
    if (!block) return
    await ensureStarted(port)
    for (const agent of await agentsNear(port, block)) console.log(JSON.stringify(agent))
  })
