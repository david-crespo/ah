// `ah workspace` and `ah debug agents`, which read the registry as the
// server last saved it, so they work with the server down, except
// `ah workspace agents`, which asks the server; and `ah doctor`.

import { Command } from "@commander-js/extra-typings"
import { resolve } from "node:path"
import type { RexState, Tab, WorkspaceRoot } from "../model.ts"
import { assetPath } from "../platform/assets.ts"
import { callServer, die, ensureStarted, portOption, serverUrl } from "./shared.ts"
import { installProblems, type Problem } from "../platform/install_check.ts"
import { currentAddress } from "../platform/session.ts"
import { agentsNear } from "./files.ts"
import { readRex } from "../platform/rex.ts"
import { blockOf, emptyRegistry, loadRegistry } from "../core/registry.ts"
import { rootFinder, tabRoot } from "../core/workspace.ts"
import { isCurrent } from "../core/core.ts"
import { listAgents, readClaudeProcesses } from "../core/agent_view.ts"
import type { Outdated } from "../core/upgrades.ts"

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

/** `ah doctor` */
export const doctor = new Command("doctor")
  .summary("List files that use an old ah format, and problems with ah's setup")
  .description(
    `List the files in this workspace (or with --all, every one) that use an old ah format, such as tracker pages loading their script from a path ah no longer serves, with what to change in each. ah finds them among the trackers it has records of and the pages it serves. Agents write these files, so ah changes none of them: an agent makes each change and checks the result. ${assetPath("docs/upgrading.md")} has more on each change. Then list what's wrong with how the harnesses have ah's skills and hooks, with the command that fixes each, which it doesn't run. ah's own state needs nothing: the server migrates it when it starts.`,
  )
  .option("--all", "Files in every workspace, not only the one this directory is in")
  .addOption(portOption())
  .action(async ({ all, port }) => {
    await ensureStarted(port)
    // As the session notice counts them: the jj workspace, or outside one
    // the directory
    const cwd = process.cwd()
    const query = all ? "" : `?root=${encodeURIComponent(rootFinder()(cwd) ?? cwd)}`
    const outdated = await callServer<Outdated[]>(serverUrl(port, `core/upgrades${query}`))
    const byWhat = Map.groupBy(outdated, (o) => o.what)
    for (const [what, files] of byWhat) {
      console.log(`${what}\n  ${files[0].how}`)
      for (const { path } of files) console.log(`  ${path}`)
    }
    const setup = installProblems()
    const problems = setup.filter((p) => !p.optional)
    const list = (heading: string, items: Problem[]) => {
      if (items.length) console.log(heading)
      for (const { problem, fix } of items) console.log(`  ${problem}\n    fix: ${fix}`)
    }
    list("Setup:", problems)
    if (!outdated.length && !problems.length) console.log("Nothing to change.")
    // The files are agent-written, so an agent reads each and makes the edit
    else if (outdated.length && !currentAddress())
      console.log(
        `\nAsk an agent working in ${all ? "each of these workspaces" : "this workspace"} to run \`ah doctor\` and make the changes to these files.`,
      )
    list(
      "Skills a harness doesn't have, which is fine if that's on purpose:",
      setup.filter((p) => p.optional),
    )
  })
