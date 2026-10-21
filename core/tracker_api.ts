// The CLI's client for the core's tracker routes (core.ts): a workspace's
// current tracker, its list, and parking or finishing one. Trackers are kept
// in the registry, which the server owns (trackers.ts), so these need it
// running.

import { callServer, serverUrl } from "../platform/cli.ts"
import { status } from "../platform/server.ts"
import type { AgentRef, TrackerEntry, TrackerStatus, WorkspaceTrackers } from "./model.ts"

const postJson = <T>(port: number, rest: string, body: unknown) =>
  callServer<T>(serverUrl(port, `core/${rest}`), { body })

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
  const url = new URL(serverUrl(port, "core/trackers"))
  url.searchParams.set("dir", dir)
  return await callServer<WorkspaceTrackers & { root: string; done: TrackerEntry[] }>(url)
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
