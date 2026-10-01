// `ah app sessions`. Reads the registry as the server last saved it, so it
// works with the server down.

import { Command } from "@commander-js/extra-typings"
import { type Snapshot, snapshotOnce } from "../dashboard/ghostty.ts"
import { hook, shell, terminal } from "./hook.ts"
import { emptyRegistry, loadRegistry } from "./registry.ts"
import { isCurrent } from "./routes.ts"
import { Harnesses, listSessions, readClaudeProcesses } from "./sessions.ts"

export const sessions = new Command("sessions")
  .description("Agent sessions across harnesses, and which terminal each is in")
  .action(function () {
    this.help()
  })

sessions
  .command("ls")
  .description("List sessions in a terminal or running, from agent hooks and Claude")
  .option("-a, --all", "Include sessions no longer in a terminal or running")
  .option("--json", "Print JSON")
  .action(async ({ all, json }) => {
    // Without Ghostty (or the Automation grant) there are no places, only sessions
    const snapshot: Snapshot | null = await snapshotOnce().then(
      (s) => s.snapshot,
      () => null,
    )
    const list = (
      await listSessions(
        loadRegistry() ?? emptyRegistry(),
        await readClaudeProcesses(),
        snapshot,
        new Harnesses(),
      )
    ).filter((s) => all || isCurrent(s))
    if (json) return console.log(JSON.stringify(list, null, 2))
    for (const s of list.toSorted((a, b) =>
      (a.place?.tab ?? "").localeCompare(b.place?.tab ?? ""),
    )) {
      const harness = s.harness ? `${s.harness}${s.harnessFrom === "id" ? "?" : ""}` : "?"
      const where = s.place ? s.place.tab : s.terminal ? "gone" : "-"
      const proc = s.process ? `pid ${s.process.pid}` : ""
      const activity = [s.busy ? "🌀" : "", s.summary ?? ""].filter(Boolean).join(" ")
      console.log([s.id.slice(0, 8), harness, where, s.label, proc, activity].join("\t"))
    }
  })

sessions
  .command("description")
  .description("Print the summary of the latest session in a directory, if any (for jjw)")
  .argument("<path>", "The directory, as the session's cwd")
  .action((path) => {
    const latest = [...(loadRegistry()?.sessions.values() ?? [])]
      .filter((s) => s.cwd === path && s.summary)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) console.log(latest.summary)
  })

sessions.addCommand(hook)
sessions.addCommand(shell)
sessions.addCommand(terminal)
