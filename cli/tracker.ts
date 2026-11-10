// `ah tool tracker`: a workspace's trackers, through the core's tracker
// routes (core.ts): its current tracker, its list, and parking or finishing
// one. Trackers are kept in the registry, which the server owns
// (trackers.ts), so these need it running.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Command } from "@commander-js/extra-typings"
import { callServer, die, portOption, serverUrl } from "./shared.ts"
import { absolute, openablePathOrDie, showInServer } from "./files.ts"
import { ensureDashboardPage } from "./dashboard.ts"
import { status } from "../platform/server.ts"
import { currentAgent } from "../platform/session.ts"
import { taskListPage } from "../views/page/task_list_file.ts"
import {
  type AgentRef,
  fileKind,
  type TrackerEntry,
  type TrackerStatus,
  type WorkspaceTrackers,
} from "../model.ts"

const postJson = <T>(port: number, rest: string, body: unknown) =>
  callServer<T>(serverUrl(port, `core/${rest}`), { body })

/** Make `path` the agent's workspace's current tracker */
async function setCurrentTracker(port: number, agent: AgentRef, path: string) {
  await postJson(port, "current-tracker", { agent, path })
}

/** The trackers of the workspace `dir` is in, finished ones included */
async function workspaceTrackers(port: number, dir: string) {
  const url = new URL(serverUrl(port, "core/trackers"))
  url.searchParams.set("dir", dir)
  return await callServer<WorkspaceTrackers & { root: string; done: TrackerEntry[] }>(url)
}

/** Park or finish the tracker at `path`. Returns its path as the server has it. */
async function setTrackerStatus(
  port: number,
  path: string,
  to: Exclude<TrackerStatus, "active">,
): Promise<string> {
  return (await postJson<{ path: string }>(port, "tracker-status", { status: to, path }))
    .path
}

/** Write a task list to `file` from the template, unless there is one */
function ensureTaskList(file: string, title?: string, goal?: string) {
  if (existsSync(file)) return
  if (!/\.html$/i.test(file)) die(`no such file: ${file}`)
  if (!title || !goal) die("ah tool tracker add: a new task list needs --title and --goal")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, taskListPage(title, goal))
  console.log(`wrote ${absolute(file)}`)
}

export const tracker = new Command("tracker")
  .description("Task trackers for a workspace")
  .action(function () {
    this.help()
  })

tracker
  .command("add")
  .summary("Add a tracker and make it the current one")
  .description(
    "Add a file to this workspace's active trackers and make it the current tracker, which the dashboard shows. A parked or finished tracker becomes active again. To start a new task list, pass --title and --goal, and ah writes it from the template. By convention a new task list goes at .claude/notes/<date>-<slug>-tracker/index.html. It gets a directory of its own because a page reloads when anything in its directory changes.",
  )
  .argument("<file>")
  .option("--title <title>", "A new task list's title")
  .option("--goal <goal>", "A new task list's goal, a sentence or two")
  .addOption(portOption())
  .action(async (file, { title, goal, port }) => {
    ensureTaskList(file, title, goal)
    const path = openablePathOrDie(file)
    const agent =
      currentAgent() ?? die("ah tool tracker add: not running in an agent session")
    // Bound the way `ah tool doc` and `page` bind; the dashboard's view of the file
    // leaves the binding alone
    await showInServer(fileKind(path), port, path)
    await setCurrentTracker(port, agent, path)
    console.log(`the tracker: ${path}`)
    // The dashboard already shows the new tracker, so an open one stays
    // behind whatever the user is looking at
    console.log(await ensureDashboardPage(port, { raise: false }))
  })

tracker
  .command("ls")
  .summary("List this workspace's trackers")
  .description(
    "List this workspace's active trackers, most recent first, with the current one marked *. Parked trackers come after them.",
  )
  .option("--done", "The finished ones instead, most recent first")
  .addOption(portOption())
  .action(async ({ done, port }) => {
    if (!(await status(port))) die("ah tool tracker ls: server not running")
    const t = await workspaceTrackers(port, process.cwd())
    if (done) {
      for (const { path } of t.done) console.log(path)
      return
    }
    for (const { path } of t.active)
      console.log(`${path === t.current ? "*" : " "} ${path}`)
    if (t.parked.length)
      console.log(`parked:\n${t.parked.map((p) => `  ${p.path}`).join("\n")}`)
  })

for (const [name, to, summary, description] of [
  [
    "park",
    "parked",
    "Set a tracker aside with work still left",
    "Set a tracker aside with work still left. It leaves the list of active trackers until you add it again.",
  ],
  [
    "finish",
    "done",
    "Mark a tracker done",
    "Mark a tracker done. It leaves the list of active trackers.",
  ],
] as const) {
  tracker
    .command(name)
    .summary(summary)
    .description(description)
    .argument("<file>")
    .addOption(portOption())
    .action(async (file, { port }) => {
      if (!(await status(port))) die(`ah tool tracker ${name}: server not running`)
      console.log(`${to}: ${await setTrackerStatus(port, absolute(file), to)}`)
    })
}
