// `ah view`, `ah message` and `ah tracker`: files an agent shows the user,
// with a conversation back to the agent, and the workspace's trackers, which
// the dashboard shows. The extension picks the backend that serves the page:
// an .html file is the agent's own page, served as is on an origin of its own
// (views/html/); anything else is markdown, rendered by ah with a helix pane
// (views/markdown/). Showing, listing and closing (subjects/files/), the thread
// (subjects/thread/) and the dashboard record are the same for both.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Command, Option } from "@commander-js/extra-typings"
import { threadCommands } from "../subjects/thread/cli.ts"
import { FILE_KINDS, fileKind, type TrackerEntry } from "../core/model.ts"
import { die, portOption, serverUrl } from "../platform/cli.ts"
import { showUrl } from "../platform/window.ts"
import {
  absolute,
  closeInServer,
  fileLine,
  showInServer,
  shownFiles,
  showPage,
} from "../subjects/files/cli.ts"
import { status } from "../platform/server.ts"
import { currentAgent } from "../platform/session.ts"
import { focusHere } from "../platform/focus.ts"
import { openFloat } from "../platform/rex.ts"
import { ensureDashboardPage } from "./dashboard/api.ts"
import { openable, rootFinder } from "../core/workspace.ts"
import { sendToTab } from "../core/send.ts"
import {
  setCurrentTracker,
  setTrackerStatus,
  workspaceTrackers,
} from "../core/tracker_api.ts"
import { taskListPage } from "./html/task_list_file.ts"

/** Where the file's thread takes the agent's events, or requests from
 * outside its page */
const fileUrl = (path: string, port: number, route: "thread" | "request") =>
  serverUrl(port, `view/${fileKind(path)}/files/${route}?path=${encodeURIComponent(path)}`)

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
  .summary("Show a file in a page you can comment on, or a URL in a window")
  .description(
    "Show a markdown or HTML file in a page you can comment on, or any URL in a window or tab. `ah view <file>` is short for `ah view open <file>`, except for a file named like a command here.",
  )

/** Any URL, like a diff review tool's page: shown in a window or
 * tab like a file's page, but with no subject ah knows, so nothing is bound
 * and there's no thread. Whatever serves it can talk to agents itself, with
 * `ah message send`. */
const isUrl = (arg: string) => /^https?:\/\//i.test(arg) && URL.canParse(arg)

view
  .command("open", { isDefault: true })
  .summary("Open a file in a page you can comment on")
  .description(
    "Open a file in a page you can comment on; `ah view <file>` does the same. Comments go to the agent session this command runs in, or run from a shell in Rex, to an agent in its tab, which it asks you to pick if there are several; the file stays bound to that agent until another opens it. HTML files are served as they are, and any other file is shown as markdown. A window or tab comes to the front when run from a shell, or from an agent whose Rex pane has focus with Rex the frontmost app; otherwise it opens without taking focus. A file already shown in a window keeps that window, which comes to the front under the same rule. Prints the page's URL, which keeps working across server restarts.\n\nGiven an http(s) URL instead of a file, open it in a window named --name or a tab. Nothing is bound to it and it has no conversation. The URL can come last, so a tool can append it to `ah view open --name <name>`.",
  )
  // Optional so that `ah view` alone, which comes here as the default, shows
  // the help rather than a missing argument
  .argument("[file]", "a file, or any http(s) URL")
  .addOption(
    new Option(
      "--in <place>",
      [
        "window: a window of its own, with its own Dock tile; tab: the default browser;",
        "split (markdown only): glow in a new Rex split 35% above this terminal, focus staying put;",
        "float (markdown only): glow in a Rex float over this terminal's tab, closing when glow quits;",
        "here (markdown only): glow in this terminal",
      ].join(" "),
    )
      .choices(["window", "tab", "split", "float", "here"] as const)
      .default("window" as const),
  )
  .option("--no-editor", "Markdown preview only, without the helix pane")
  .option("--no-chat", "Without the conversation")
  .option(
    "--name <name>",
    "A URL's window: what the Dock calls it (default: the URL's hostname). Each name makes a copy of the window app, so keep it stable.",
  )
  .addOption(portOption())
  .action(async (file, { in: place, editor, chat, name, port }) => {
    if (!file) return view.help()
    if (isUrl(file)) {
      if (place !== "window" && place !== "tab")
        die(`ah view open --in ${place}: files only`)
      const dockName = name ?? new URL(file).hostname
      await showUrl(place, file, {
        name: dockName,
        badge: dockName.charAt(0).toUpperCase(),
        color: "#475569",
      })
      return console.log(file)
    }
    if (name !== undefined)
      die("ah view open --name: URLs only; a file's window is named after it")
    const path = openablePathOrDie(file)
    const kind = fileKind(path)
    if ((place === "split" || place === "float" || place === "here") && kind === "html") {
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
    if (place === "float") {
      const session =
        process.env.REX_SESSION ?? die("ah view open --in float: not running in Rex")
      const block =
        process.env.REX_BLOCK ?? die("ah view open --in float: not running in Rex")
      // It covers the caller's pane, so it takes focus by the same rule as a
      // window: when the person is looking at that pane
      const { take } = await focusHere()
      return await openFloat(session, block, {
        label: basename(path),
        command: ["glow", "--tui", path],
        focus: take,
      })
    }
    if (place === "here") return await runInherited("glow", ["--tui", path])
    const { url, views } = await showInServer(kind, port, path)
    if (!editor && kind === "markdown") url.searchParams.set("editor", "off")
    if (!chat) url.searchParams.set("chat", "off")
    await showPage(place, url, path, views)
  })

view
  .command("ls")
  .summary("List the files pages show")
  .description(
    "List the files pages show now, one line per file. Each line shows the file's id, its path, where its pages are (window, tab, or dashboard), the agent it's bound to, and where its comments go.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    if (!(await status(port))) return console.error("ah: server not running, nothing shown")
    const files = (
      await Promise.all(FILE_KINDS.map((kind) => shownFiles(kind, port)))
    ).flat()
    for (const f of files) console.log(fileLine(f))
  })

view
  .command("close")
  .summary("Close a file's windows")
  .description(
    "Close the windows and browser tabs that show a file. The dashboard keeps showing it if it's a tracker there. The file stays bound to its agent, and comments sent to it still arrive.",
  )
  .argument("<file>")
  .addOption(portOption())
  .action(async (file, { port }) => {
    // The file may be gone by now
    const path = absolute(file)
    const result = await closeInServer(fileKind(path), port, path)
    if (result === "no server")
      return console.error("ah: server not running, nothing shown")
    if (result !== "closed") return console.error(`ah: no window shows ${path}`)
    console.log(`closed ${path}`)
  })

export const message = new Command("message")
  .summary("Exchange messages with agent sessions")
  .description(
    "Messages between the user and agents: what's waiting, and the agent's answers",
  )
  .action(function () {
    this.help()
  })
for (const command of threadCommands(fileUrl, sendToTab)) message.addCommand(command)

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
    // Bound the way `ah view open` binds; the dashboard's view of the file
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
