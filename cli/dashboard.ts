// `ah tool dashboard`, and what other commands use to show the dashboard:
// whether a page is open, and opening one. Setting what it shows, the
// workspace's current tracker, is tracker.ts.

import { Command, Option } from "@commander-js/extra-typings"
import { callServer, ensureStarted, portOption, serverUrl } from "./shared.ts"
import { status } from "../platform/server.ts"
import { focusHere } from "../platform/focus.ts"
import { currentAgent } from "../platform/session.ts"
import { focusWindow, openWindow } from "../platform/window.ts"

const dashboardUrl = (port: number) => serverUrl(port, "view/dashboard/")

/** One line for agents deciding where to show things */
async function dashboardStatus(port: number): Promise<string> {
  const s = await status(port)
  if (!s) return "dashboard: not running"
  if (!s.pages) return "dashboard: server running, no page open"
  return `dashboard: open (${s.pages} ${s.pages === 1 ? "page" : "pages"})`
}

/** Make sure a dashboard page is open to show what we just put in it,
 * opening one if there is none. With `raise`, an open one's window comes
 * forward if `focusHere` allows; without, it stays where it is, since it
 * updates in place. Returns a status line like dashboardStatus. */
export async function ensureDashboardPage(
  port: number,
  { otherDisplay = true, raise = true }: { otherDisplay?: boolean; raise?: boolean } = {},
): Promise<string> {
  const s = await status(port)
  if (s?.pages) {
    if (raise && (await focusHere()).take) await focusWindow(dashboardUrl(port))
    return await dashboardStatus(port)
  }
  // Taking focus only as `focusHere` allows
  await ensureStarted(port)
  await openWindow(
    dashboardUrl(port),
    { name: "Dashboard", badge: "ah", color: "#4f46e5", otherDisplay },
    await focusHere(),
  )
  return "dashboard: no page was open, opened one"
}

export const dashboard = new Command("dashboard")
  .summary("A window that follows the focused Rex tab")
  .description(
    "A window that follows the focused Rex tab. `ah tool dashboard` is short for `ah tool dashboard open`.",
  )

dashboard
  .command("open", { isDefault: true })
  .summary("Open the dashboard window")
  .description(
    "Open the dashboard window, or if it's already open, keep that one. The window comes to the front when run from a shell, or from an agent whose Rex pane has focus with Rex the frontmost app; otherwise it opens or stays without taking focus.",
  )
  .addOption(
    new Option("--in <place>", "window: a window of its own, with its own Dock tile")
      .choices(["window"])
      .default("window"),
  )
  .option(
    "--no-other-display",
    "Leave the window where macOS puts it, instead of filling a display without the pointer",
  )
  .addOption(portOption())
  .action(async ({ port, otherDisplay }) => {
    console.log(await ensureDashboardPage(port, { otherDisplay }))
  })

dashboard
  .command("status")
  .summary("Show whether the dashboard is open")
  .description(
    "Show whether the dashboard is open, and this workspace's current tracker, which the dashboard shows.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    console.log(await dashboardStatus(port))
    const agent = currentAgent()
    if (!agent || !(await status(port))) return
    const url = serverUrl(port, "core/current-tracker")
    const { path } = await callServer<{ path: string | null }>(url, { body: { agent } })
    if (path) console.log(`in the dashboard: ${path}`)
  })
