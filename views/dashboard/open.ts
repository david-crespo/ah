// Opening the dashboard window, shared by `ah dashboard open` and the
// commands that put something in the dashboard

import { ensureStarted, serverUrl } from "../../platform/cli.ts"
import { focusHere } from "../../platform/focus.ts"
import { openWindow } from "../../platform/window.ts"

export const dashboardUrl = (port: number) => serverUrl(port, "view/dashboard/")

/** Open a dashboard page in a window, taking focus only as `focusHere`
 * allows */
export async function openDashboard(port: number, otherDisplay = true) {
  await ensureStarted(port)
  await openWindow(
    dashboardUrl(port),
    { name: "Dashboard", badge: "ah", color: "#4f46e5", otherDisplay },
    await focusHere(),
  )
}
