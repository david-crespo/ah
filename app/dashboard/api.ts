// What other apps' commands use to put a file in the dashboard. Each agent
// session has at most one, kept as a record on disk (docs.ts) rather than in
// the server, so these work whether or not it runs.

import { status } from "../../host/server.ts"
import type { Agent } from "../../host/session.ts"
import {
  clearFile,
  clearSession,
  defaultDirs,
  liveRecords,
  repoRoot,
  type ShownFile,
  writeRecord,
} from "./docs.ts"
import { openDashboard } from "./open.ts"

/** The session's workspace, or the cwd outside a checkout */
export const sessionRoot = () => repoRoot(process.cwd()) ?? process.cwd()

/** Show `file` as the session's file, replacing any it had */
export function showFile(agent: Agent, file: string) {
  writeRecord(defaultDirs(), {
    ...agent,
    root: sessionRoot(),
    file,
    since: new Date().toISOString(),
  })
}

/** Stop showing `file` in whichever sessions have it */
export const clearShownFile = (file: string) => clearFile(defaultDirs(), file)

/** Stop showing the session's file */
export const clearSessionFile = (agent: Agent) => clearSession(defaultDirs(), agent.key)

/** Files live sessions show, newest first */
export const shownFiles = (): ShownFile[] => liveRecords(defaultDirs())

export const sessionFile = (agent: Agent): string | null =>
  shownFiles().find((r) => r.key === agent.key)?.file ?? null

/** One line for agents deciding where to show things */
export async function dashboardStatus(port: number): Promise<string> {
  const s = await status(port)
  if (!s) return "dashboard: not running"
  if (!s.pages) return "dashboard: server running, no page open"
  return `dashboard: open (${s.pages} ${s.pages === 1 ? "page" : "pages"})`
}

/** Make sure a dashboard page is open to show what we just put in it,
 * opening one if there is none. Returns a status line like dashboardStatus. */
export async function ensureDashboardPage(
  port: number,
  otherDisplay = true,
): Promise<string> {
  const s = await status(port)
  if (s?.pages) return await dashboardStatus(port)
  await openDashboard(port, otherDisplay)
  return "dashboard: no page was open, opened one"
}
