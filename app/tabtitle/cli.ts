// `ah app tabtitle`: Rex tab titles, which the server sets from the
// session registry (setter.ts). `check` compares what each tab shows with the
// title ah computes, from the registry as last saved.

import { Command } from "@commander-js/extra-typings"
import { snapshotOnce } from "../../host/rex.ts"
import { emptyRegistry, loadRegistry } from "../sessions/registry.ts"
import { tabLabel } from "./setter.ts"

export const tabtitle = new Command("tabtitle")
  .description("Tab titles, set from the agent sessions in each tab")
  .action(function () {
    this.help()
  })

tabtitle
  .command("check")
  .description("Compare each tab's title with the one ah computes, once")
  .action(async () => {
    const snapshot = await snapshotOnce()
    const registry = loadRegistry() ?? emptyRegistry()
    let mismatches = 0
    for (const tab of snapshot.windows.flatMap((w) => w.tabs)) {
      const expected = tabLabel(
        tab.terminals.map((t) => t.id),
        registry,
      )
      const same = expected === undefined || expected === tab.name
      if (!same) mismatches++
      console.log(`${same ? "=" : "≠"} ${tab.id}\t${tab.name}`)
      if (!same) console.log(`  ah: ${expected}`)
    }
    if (mismatches) process.exitCode = 1
  })
