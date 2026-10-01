// Opening the dashboard window, shared by `ah app dashboard open` and the
// commands that put something in the dashboard

import { ensureStarted } from "../../host/cli.ts"
import { run } from "../../host/proc.ts"
import { moveToOtherDisplay } from "./display.ts"

/** Open a dashboard page in a Chrome app window */
export async function openDashboard(port: number, otherDisplay = true) {
  await ensureStarted(port)
  const url = `http://127.0.0.1:${port}/app/dashboard/`
  await run("open", ["-na", "Google Chrome", "--args", `--app=${url}`])
  if (otherDisplay) console.error(`ah: ${await moveToOtherDisplay(url)}`)
}
