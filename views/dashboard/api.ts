// What other groups' commands use to show the dashboard: whether a page is
// open, and opening one. Setting what it shows, the workspace's current
// tracker, is core/tracker_api.ts.

import { status } from "../../platform/server.ts"
import { focusHere } from "../../platform/focus.ts"
import { focusWindow } from "../../platform/window.ts"
import { dashboardUrl, openDashboard } from "./open.ts"

/** One line for agents deciding where to show things */
export async function dashboardStatus(port: number): Promise<string> {
  const s = await status(port)
  if (!s) return "dashboard: not running"
  if (!s.pages) return "dashboard: server running, no page open"
  return `dashboard: open (${s.pages} ${s.pages === 1 ? "page" : "pages"})`
}

/** Make sure a dashboard page is open to show what we just put in it,
 * opening one if there is none, or bringing its window forward if
 * `focusHere` allows. Returns a status line like dashboardStatus. */
export async function ensureDashboardPage(
  port: number,
  otherDisplay = true,
): Promise<string> {
  const s = await status(port)
  if (s?.pages) {
    if ((await focusHere()).take) await focusWindow(dashboardUrl(port))
    return await dashboardStatus(port)
  }
  await openDashboard(port, otherDisplay)
  return "dashboard: no page was open, opened one"
}
