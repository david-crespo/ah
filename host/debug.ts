// `ah debug`

import { Command } from "@commander-js/extra-typings"
import { snapshotOnce } from "./rex.ts"
import { resolve, rootFinder } from "../app/dashboard/workspace.ts"
import { emptyRegistry, loadRegistry } from "../app/sessions/registry.ts"
import { tabLabel } from "../app/tabtitle/setter.ts"

export const debug = new Command("debug").description("Commands for debugging the host")

debug
  .command("tabs")
  .description(
    "Print one Rex snapshot, how long it took, the workspaces it resolves to, and each tab's title vs the one ah computes",
  )
  .action(async () => {
    const start = performance.now()
    const snapshot = await snapshotOnce()
    const totalMs = Math.round(performance.now() - start)
    const state = resolve(snapshot, rootFinder(), null)
    // From the registry as last saved, which can trail the server's by a
    // moment; /app/tabtitle/ has the server's own
    const registry = loadRegistry() ?? emptyRegistry()
    const titles = snapshot.windows
      .flatMap((w) => w.tabs)
      .map((tab) => {
        const ah = tabLabel(
          tab.terminals.map((t) => t.id),
          registry,
        )
        return {
          id: tab.id,
          shows: tab.name,
          ah,
          same: ah === undefined || ah === tab.name,
        }
      })
    console.log(JSON.stringify({ totalMs, state, titles, snapshot }, null, 2))
  })
