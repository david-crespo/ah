// `ah debug`

import { Command } from "@commander-js/extra-typings"
import { snapshotOnce } from "../app/dashboard/ghostty.ts"
import { resolve, rootFinder } from "../app/dashboard/workspace.ts"

export const debug = new Command("debug").description("Commands for debugging the host")

debug
  .command("tabs")
  .description("Print one Ghostty snapshot, its timings, and the workspaces it resolves to")
  .action(async () => {
    const start = performance.now()
    const { snapshot, timing } = await snapshotOnce()
    const totalMs = Math.round(performance.now() - start)
    const state = resolve(snapshot, rootFinder(), null)
    console.log(JSON.stringify({ totalMs, timing, state, snapshot }, null, 2))
  })
