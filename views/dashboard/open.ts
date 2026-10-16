// Opening the dashboard window, shared by `ah dashboard open` and the
// commands that put something in the dashboard

import { ensureStarted } from "../../platform/cli.ts"
import { run } from "../../platform/proc.ts"
import { moveToOtherDisplay } from "./display.ts"

/** Open a dashboard page in a Chrome app window */
export async function openDashboard(port: number, otherDisplay = true) {
  await ensureStarted(port)
  const url = `http://127.0.0.1:${port}/view/dashboard/`
  await run("open", ["-na", "Google Chrome", "--args", `--app=${url}`])
  if (otherDisplay) console.error(`ah: ${await moveToOtherDisplay(url)}`)
}
