// `ah app sessions`. Reads the registry as the server last saved it, so it
// works with the server down.

import { Command } from "@commander-js/extra-typings"
import { type Snapshot, snapshotOnce } from "../../host/rex.ts"
import { emptyRegistry, loadRegistry } from "./registry.ts"
import { isCurrent } from "./routes.ts"
import { listAgents, readClaudeProcesses } from "./sessions.ts"

export const sessions = new Command("sessions")
  .description("Agents across harnesses, and which terminal each is in")
  .action(function () {
    this.help()
  })

sessions
  .command("ls")
  .description("List agents in a terminal or running, from agent hooks and Claude")
  .option("-a, --all", "Include agents no longer in a terminal or running")
  .option("--json", "Print JSON")
  .action(async ({ all, json }) => {
    // Without Rex there are no places, only agents
    const snapshot: Snapshot | null = await snapshotOnce().catch(() => null)
    const list = listAgents(
      loadRegistry() ?? emptyRegistry(),
      await readClaudeProcesses(),
      snapshot,
    ).filter((s) => all || isCurrent(s))
    if (json) return console.log(JSON.stringify(list, null, 2))
    for (const s of list.toSorted((a, b) =>
      (a.place?.tab ?? "").localeCompare(b.place?.tab ?? ""),
    )) {
      const where = s.place ? s.place.tab : s.terminal ? "gone" : "-"
      const proc = s.process ? `pid ${s.process.pid}` : ""
      const activity = [s.busy ? "🌀" : "", s.summary ?? ""].filter(Boolean).join(" ")
      const session = s.session.slice(0, 8)
      console.log([session, s.harness, where, s.label, proc, activity].join("\t"))
    }
  })

sessions
  .command("description")
  .description("Print the summary of the latest session in a directory, if any (for jjw)")
  .argument("<path>", "The directory, as the session's cwd")
  .action((path) => {
    const latest = [...(loadRegistry()?.agents.values() ?? [])]
      .filter((s) => s.cwd === path && s.summary)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) console.log(latest.summary)
  })
