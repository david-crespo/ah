// `ah debug`: `tabs`, which shows the workspaces the dashboard maps Rex's
// tabs to and the titles ah gives them, and `agents`. Both read the registry
// as the server last saved it, so they work with the server down.

import { Command } from "@commander-js/extra-typings"
import type { RexState } from "../model.ts"
import { readRex } from "../platform/rex.ts"
import { emptyRegistry, loadRegistry } from "../core/registry.ts"
import { tabLabel } from "../core/tabtitle/setter.ts"
import { rootFinder } from "../core/workspace.ts"
import { isCurrent, listAgents, readClaudeProcesses } from "../core/agent_view.ts"
import { resolve } from "../views/dashboard/workspace.ts"

const tabs = new Command("tabs")
  .summary("Show Rex's tabs as ah sees them")
  .description(
    "Read Rex's state once and print it, along with how long the read took, the workspaces it maps to, and each tab's title next to the title ah computes.",
  )
  .action(async () => {
    const start = performance.now()
    const rex = await readRex()
    const totalMs = Math.round(performance.now() - start)
    const state = resolve(rex, rootFinder(), null)
    // From the registry as last saved, which can trail the server's by a
    // moment; /tabtitles has the server's own
    const registry = loadRegistry() ?? emptyRegistry()
    const titles = rex.sessions
      .flatMap((s) => s.tabs)
      .map((tab) => {
        const ah = tabLabel(
          tab.blocks.map((t) => t.id),
          registry,
        )
        return {
          id: tab.id,
          shows: tab.name,
          ah,
          same: ah === undefined || ah === tab.name,
        }
      })
    console.log(JSON.stringify({ totalMs, state, titles, rex }, null, 2))
  })

const agents = new Command("agents")
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

export const debug = new Command("debug")
  .description("Inspect how ah sees Rex tabs and the agents in them")
  .addCommand(tabs)
  .addCommand(agents)
