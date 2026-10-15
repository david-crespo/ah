// What other apps' commands use to put a file in the dashboard. Each tab has
// at most one, set by any agent in it, kept in the agent registry
// (app/sessions/registry.ts), which the server owns, so these need it
// running.

import { statSync } from "node:fs"
import { dirname, join } from "node:path"
import { serverJson } from "../../host/cli.ts"
import { status } from "../../host/server.ts"
import type { AgentRef } from "../sessions/registry.ts"
import type { HomeFile } from "../sessions/routes.ts"
import { openDashboard } from "./open.ts"

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Nearest ancestor of `dir` (inclusive) that's a jj or git checkout. */
export function repoRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, ".jj")) || exists(join(d, ".git"))) return d
    if (dirname(d) === d) return null
  }
}

/** The session's workspace, or the cwd outside a checkout */
export const sessionRoot = () => repoRoot(process.cwd()) ?? process.cwd()

const sessionsUrl = (port: number, rest: string) =>
  `http://127.0.0.1:${port}/app/sessions/${rest}`

async function postJson<T>(port: number, rest: string, body: unknown): Promise<T> {
  const res = await fetch(sessionsUrl(port, rest), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`ah: ${rest}: ${res.status} ${await res.text()}`)
  return await serverJson<T>(res)
}

/** Show `file` as the agent's tab's file, or with null stop showing one.
 * Returns the file it had. */
export async function setAgentFile(
  port: number,
  agent: AgentRef,
  file: string | null,
): Promise<string | null> {
  const { previous } = await postJson<{ previous: string | null }>(port, "file", {
    agent,
    file,
  })
  return previous
}

/** The agent's tab's file, or null if it has none or the server isn't
 * running */
export async function agentFile(port: number, agent: AgentRef): Promise<string | null> {
  if (!(await status(port))) return null
  return (await postJson<{ file: string | null }>(port, "file", { agent })).file
}

/** Stop showing `file` in whichever tabs have it. Returns how many did. */
export async function clearShownFile(port: number, file: string): Promise<number> {
  if (!(await status(port))) return 0
  return (await postJson<{ cleared: number }>(port, "clear-file", { file })).cleared
}

/** Every file in the dashboard */
export async function shownFiles(port: number): Promise<HomeFile[]> {
  if (!(await status(port))) return []
  return await serverJson<HomeFile[]>(await fetch(sessionsUrl(port, "files")))
}

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
