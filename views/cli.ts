// `ah view`, `ah request` and `ah tracker`: files an agent shows the user,
// with a conversation back to the agent, and the workspace's trackers, which
// the dashboard shows. The extension picks the backend that serves the page:
// an .html file is the agent's own page, served as is on an origin of its own
// (views/html/); anything else is markdown, rendered by ah with a helix pane
// (views/markdown/). Opening, listing and closing (subjects/files/), the thread
// (subjects/thread/) and the dashboard record are the same for both.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Command, Option } from "@commander-js/extra-typings"
import { threadCommands } from "../subjects/thread/cli.ts"
import { FILE_KINDS, fileKind, type TrackerEntry } from "../core/model.ts"
import { die, portOption } from "../platform/cli.ts"
import {
  absolute,
  closeInServer,
  openInServer,
  fileLine,
  openFiles,
  showPage,
} from "../subjects/files/cli.ts"
import { fileId } from "../subjects/id.ts"
import { status } from "../platform/server.ts"
import { currentAgent } from "../platform/session.ts"
import { ensureDashboardPage } from "./dashboard/api.ts"
import { openable, rootFinder } from "../core/workspace.ts"
import {
  setCurrentTracker,
  setTrackerStatus,
  workspaceTrackers,
} from "../core/tracker_api.ts"
import { taskListPage } from "./html/task_list_file.ts"

/** Where the file's thread takes the agent's events */
const threadUrl = (path: string, port: number) =>
  fileKind(path) === "html"
    ? `http://127.0.0.1:${port}/view/html/${fileId(path)}/_ah/activity`
    : `http://127.0.0.1:${port}/view/markdown/${fileId(path)}/activity`

/** The file's real path, or exit with a hint if it's only in the notes dir */
/** `realPathOrDie`, for a file to serve: under the cwd or its workspace */
function openablePathOrDie(file: string): string {
  const path = realPathOrDie(file)
  if (!openable(path, process.cwd())) {
    die(`ah: ${path} is outside this directory and its jj workspace, so ah won't serve it`)
  }
  return path
}

function realPathOrDie(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    const root = rootFinder()(process.cwd()) ?? process.cwd()
    const inNotes = join(root, ".claude/notes", file)
    let hint = ""
    try {
      if (statSync(inNotes).isFile()) {
        hint = ` (did you mean ${relative(process.cwd(), inNotes)}?)`
      }
    } catch {
      /* not there either */
    }
    die(`no such file: ${file}${hint}`)
  }
}

/** Run a command with inherited stdio, exiting with its code if it fails */
async function runInherited(cmd: string, args: string[]) {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", resolve)
  })
  if (code !== 0) process.exit(code ?? 1)
}

/** Write a task list to `file` from the template, unless there is one */
function ensureTaskList(file: string, title?: string, goal?: string) {
  if (existsSync(file)) return
  if (!/\.html$/i.test(file)) die(`no such file: ${file}`)
  if (!title || !goal) die("ah tracker add: a new task list needs --title and --goal")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, taskListPage(title, goal))
  console.log(`wrote ${absolute(file)}`)
}

export const view = new Command("view")
  .description("Show a markdown or HTML file in a page you can comment on")
  .action(function () {
    this.help()
  })

view
  .command("open")
  .summary("Open a file in a page you can comment on")
  .description(
    "Open a file in a page you can comment on. Comments go to the agent session this command runs in, or run from a shell in Rex, to an agent in its tab, which it asks you to pick if there are several. HTML files are served as they are, and any other file is shown as markdown. A window or tab comes to the front when run from a shell, or from an agent whose Rex pane has focus with Rex the frontmost app; otherwise it opens without taking focus. A file already open in a window keeps that window, which comes to the front under the same rule.",
  )
  .argument("<file>")
  .addOption(
    new Option(
      "--in <place>",
      [
        "window: a window of its own, with its own Dock tile; tab: the default browser;",
        "split (markdown only): glow in a new Rex split 35% above this terminal, focus staying put;",
        "here (markdown only): glow in this terminal",
      ].join(" "),
    )
      .choices(["window", "tab", "split", "here"] as const)
      .default("window" as const),
  )
  .option("--no-editor", "Markdown preview only, without the helix pane")
  .option("--no-chat", "Without the conversation")
  .addOption(portOption())
  .action(async (file, { in: place, editor, chat, port }) => {
    const path = openablePathOrDie(file)
    const kind = fileKind(path)
    if ((place === "split" || place === "here") && kind === "html") {
      die(`ah view open --in ${place}: glow only shows markdown`)
    }
    // glow's TUI watches the file itself and keeps scroll position across reloads
    if (place === "split") {
      const block =
        process.env.REX_BLOCK ?? die("ah view open --in split: not running in Rex")
      return await runInherited("rex", [
        "split",
        "--block",
        block,
        "--split",
        "above",
        "--ratio",
        "35",
        "--focus=false",
        "--label",
        basename(path),
        "--",
        "glow",
        "--tui",
        path,
      ])
    }
    if (place === "here") return await runInherited("glow", ["--tui", path])
    const { url, views } = await openInServer(kind, port, path)
    if (!editor && kind === "markdown") url.searchParams.set("editor", "off")
    if (!chat) url.searchParams.set("chat", "off")
    await showPage(place, url, path, views)
  })

view
  .command("ls")
  .summary("List the files open in pages")
  .description(
    "List the files open in pages, one line per file. Each line shows the file's id, its path, where its pages are (window, tab, or dashboard), the agent it belongs to, and where its comments go. After those come the files the server still has open but no page shows. Comments sent to these files are still delivered.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    if (!(await status(port))) return console.error("ah: server not running, no files open")
    const files = (
      await Promise.all(FILE_KINDS.map((kind) => openFiles(kind, port)))
    ).flat()
    const shown = files.filter((f) => f.views.length)
    const unshown = files.filter((f) => !f.views.length)
    for (const f of shown) console.log(fileLine(f))
    if (!unshown.length) return
    if (shown.length) console.log()
    console.log("# open, no page connected")
    for (const f of unshown) console.log(fileLine(f))
  })

view
  .command("close")
  .summary("Stop showing a file")
  .description(
    "Stop showing a file. Its pages show that it's closed. If the file is a tracker, it stays a tracker, and the dashboard opens it again.",
  )
  .argument("<file>")
  .addOption(portOption())
  .action(async (file, { port }) => {
    // The file may be gone by now
    const path = absolute(file)
    const result = await closeInServer(fileKind(path), port, path)
    if (result === "no server") return console.error("ah: server not running, nothing open")
    if (result !== "closed") return console.error(`ah: ${path} isn't open`)
    console.log(`closed ${path}`)
  })

export const request = new Command("request")
  .description("Send and receive comments from pages")
  .action(function () {
    this.help()
  })
for (const command of threadCommands(threadUrl)) request.addCommand(command)

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
    const agent = currentAgent() ?? die("ah tracker add: not running in an agent session")
    // Bound by opening the file, since bindings live on open files. The
    // dashboard's view of the file leaves the binding alone; `ah server
    // restart` carries it over.
    await openInServer(fileKind(path), port, path)
    await setCurrentTracker(port, agent, path)
    console.log(`the tracker: ${path}`)
    console.log(await ensureDashboardPage(port))
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
    if (!(await status(port))) die("ah tracker ls: server not running")
    const t = await workspaceTrackers(port, process.cwd())
    const pathsOf = (entries: TrackerEntry[]) =>
      entries.flatMap((a) => ("path" in a.subject ? [a.subject.path] : []))
    if (done) {
      for (const path of pathsOf(t.done)) console.log(path)
      return
    }
    const current = t.current && "path" in t.current ? t.current.path : null
    for (const path of pathsOf(t.active))
      console.log(`${path === current ? "*" : " "} ${path}`)
    const parked = pathsOf(t.parked)
    if (parked.length) console.log(`parked:\n${parked.map((p) => `  ${p}`).join("\n")}`)
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
      if (!(await status(port))) die(`ah tracker ${name}: server not running`)
      console.log(`${to}: ${await setTrackerStatus(port, resolve(file), to)}`)
    })
}
