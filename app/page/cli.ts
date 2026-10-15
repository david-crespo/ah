// `ah app page`: files an agent shows the user, with a conversation back to
// the agent. The extension picks the backend that serves the page: an .html
// file is the agent's own page, served as is on an origin of its own
// (app/html/); anything else is markdown, rendered by ah with a helix pane
// (app/markdown/). Opening, listing and closing (host/files/), the thread
// (host/chat/) and the dashboard record are the same for both.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { Command, Option } from "@commander-js/extra-typings"
import { threadCommands } from "../../host/chat/cli.ts"
import { die, portOption } from "../../host/cli.ts"
import {
  absolute,
  closeInServer,
  openInServer,
  printOpenFiles,
  showPage,
} from "../../host/files/cli.ts"
import { fileId } from "../../host/id.ts"
import { status } from "../../host/server.ts"
import { currentAgent } from "../../host/session.ts"
import {
  agentFile,
  clearShownFile,
  ensureDashboardPage,
  sessionRoot,
  setAgentFile,
  shownFiles,
} from "../dashboard/api.ts"
import { trackerPage } from "../html/tracker_file.ts"

export const pageBackends = ["markdown", "html"] as const
type Backend = (typeof pageBackends)[number]

const backend = (path: string): Backend => (/\.html?$/i.test(path) ? "html" : "markdown")

/** Where the file's thread takes the agent's events */
const threadUrl = (path: string, port: number) =>
  backend(path) === "html"
    ? `http://127.0.0.1:${port}/app/html/${fileId(path)}/_ah/activity`
    : `http://127.0.0.1:${port}/app/markdown/${fileId(path)}/activity`

/** The file's real path, or exit with a hint if it's only in the notes dir */
function realPathOrDie(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    const inNotes = join(sessionRoot(), ".claude/notes", file)
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

/** Write a tracker to `file` from the template, unless there is one */
function ensureTracker(file: string, title?: string, goal?: string) {
  if (!/\.html$/i.test(file)) die("ah app page open --tracker: a tracker is an .html file")
  if (existsSync(file)) return
  if (!title || !goal)
    die("ah app page open --tracker: a new tracker needs --title and --goal")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, trackerPage(title, goal))
  console.log(`wrote ${absolute(file)}`)
}

/** Show `path` as the file for this agent's tab in the dashboard */
async function openInDashboard(path: string, port: number) {
  const agent =
    currentAgent() ??
    die("ah app page open --in dashboard: not running in an agent session")
  // Bound here rather than through the registry, which is on disk and so
  // can't hold the session's token. The dashboard's view of the file leaves
  // the binding alone; `ah server restart` carries it over.
  await openInServer(backend(path), port, path)
  await setAgentFile(port, agent, path)
  console.log(`in the dashboard: ${path}`)
  console.log(await ensureDashboardPage(port))
}

export const page = new Command("page")
  .description(
    "Markdown and HTML files an agent shows the user, live reloaded, with a conversation back to the agent",
  )
  .action(function () {
    this.help()
  })

page
  .command("open")
  .description(
    "Open a file, bound to the agent session this runs in so comments go to it; .html files are served as is, anything else as markdown",
  )
  .argument("<file>")
  .addOption(
    new Option(
      "--in <place>",
      [
        "window: a Chrome app window; tab: the default browser;",
        "dashboard: as this session's file in the dashboard, until the session ends or it's closed,",
        "without the conversation, opening a dashboard page if none is open;",
        "split (markdown only): glow in a new Rex split 35% above this terminal, focus staying put;",
        "here (markdown only): glow in this terminal",
      ].join(" "),
    )
      .choices(["window", "tab", "dashboard", "split", "here"] as const)
      .makeOptionMandatory(),
  )
  .option("--no-editor", "Markdown preview only, without the helix pane")
  .option("--no-chat", "Without the conversation")
  .option(
    "--tracker",
    "If the file doesn't exist, write a tracker there from the template first, given --title and --goal; by convention .claude/notes/<date>-<slug>-tracker/index.html, in a directory of its own since a page reloads on any change in its directory",
  )
  .option("--title <title>", "A new tracker's title")
  .option("--goal <goal>", "A new tracker's goal, a sentence or two")
  .addOption(portOption())
  .action(async (file, { in: place, editor, chat, tracker, title, goal, port }) => {
    if (tracker) ensureTracker(file, title, goal)
    const path = realPathOrDie(file)
    const kind = backend(path)
    if (place === "dashboard") {
      return await openInDashboard(path, port)
    }
    if ((place === "split" || place === "here") && kind === "html") {
      die(`ah app page open --in ${place}: glow only shows markdown`)
    }
    // glow's TUI watches the file itself and keeps scroll position across reloads
    if (place === "split") {
      const block =
        process.env.REX_BLOCK ?? die("ah app page open --in split: not running in Rex")
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
    const url = await openInServer(kind, port, path)
    if (!editor && kind === "markdown") url.searchParams.set("editor", "off")
    if (!chat) url.searchParams.set("chat", "off")
    await showPage(place, url)
  })

page
  .command("ls")
  .description(
    "Files agents show in the dashboard, then files the server has open, oldest first",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    if (!(await status(port))) return console.error("ah: server not running, no files open")
    for (const f of await shownFiles(port)) {
      console.log(["dashboard", f.tab ?? f.home, f.path].join("\t"))
    }
    for (const kind of pageBackends) await printOpenFiles(kind, port)
  })

page
  .command("close")
  .description(
    "Stop serving a file and showing it in the dashboard, and its pages say it's closed; without one, the file for this agent's tab in the dashboard",
  )
  .argument("[file]")
  .addOption(portOption())
  .action(async (file, { port }) => {
    let path: string
    let shown: boolean
    if (file) {
      // The file may be gone by now
      path = absolute(file)
      shown = (await clearShownFile(port, path)) > 0
    } else {
      const agent =
        currentAgent() ?? die("ah app page close: not in an agent session, pass the file")
      const current = await agentFile(port, agent)
      if (!current) return console.error("ah: this tab has nothing in the dashboard")
      path = current
      await setAgentFile(port, agent, null)
      shown = true
    }
    const result = await closeInServer(backend(path), port, path)
    if (result !== "closed" && !shown) {
      if (result === "no server")
        return console.error("ah: server not running, nothing open")
      return console.error(`ah: ${path} isn't open`)
    }
    console.log(`closed ${path}`)
  })

for (const command of threadCommands(threadUrl)) page.addCommand(command)
