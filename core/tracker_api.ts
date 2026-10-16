// The CLI's client for the core's tracker routes (core.ts): a workspace's
// current tracker, its list, and parking or finishing one. Trackers are kept
// in the registry, which the server owns (trackers.ts), so these need it
// running.

import { die, serverJson } from "../platform/cli.ts"
import { status } from "../platform/server.ts"
import type { AgentRef, TrackerEntry, TrackerStatus, WorkspaceTrackers } from "./model.ts"

const coreUrl = (port: number, rest: string) => `http://127.0.0.1:${port}/core/${rest}`

/** POST to a core route; a non-2xx response exits with its body */
async function postJson<T>(port: number, rest: string, body: unknown): Promise<T> {
  const res = await fetch(coreUrl(port, rest), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) die(`ah: ${rest}: ${res.status} ${(await res.text()).trim()}`)
  return await serverJson<T>(res)
}

/** Make `path` the agent's workspace's current tracker */
export async function setCurrentTracker(port: number, agent: AgentRef, path: string) {
  await postJson(port, "current-tracker", { agent, path })
}

/** The agent's workspace's current tracker, or null if it has none or the
 * server isn't running */
export async function currentTracker(
  port: number,
  agent: AgentRef,
): Promise<string | null> {
  if (!(await status(port))) return null
  return (await postJson<{ path: string | null }>(port, "current-tracker", { agent })).path
}

/** The trackers of the workspace `dir` is in, finished ones included */
export async function workspaceTrackers(port: number, dir: string) {
  const url = new URL(coreUrl(port, "trackers"))
  url.searchParams.set("dir", dir)
  const res = await fetch(url)
  if (!res.ok) die(`ah: trackers: ${(await res.text()).trim()}`)
  return await serverJson<WorkspaceTrackers & { root: string; done: TrackerEntry[] }>(res)
}

/** Park or finish the tracker at `path`. Returns its path as the server has it. */
export async function setTrackerStatus(
  port: number,
  path: string,
  to: Exclude<TrackerStatus, "active">,
): Promise<string> {
  return (await postJson<{ path: string }>(port, "tracker-status", { status: to, path }))
    .path
}
