// `ah tool`, `ah window` and `ah message`: the tools that show the user files
// an agent wrote, with a conversation back to the agent, and the workspace's
// trackers, which the dashboard shows; the windows they're in; and the
// messages between pages and agents. `ah tool doc` is a markdown or AsciiDoc
// file, rendered by ah with a helix pane (views/doc/); `ah tool page` is
// an HTML file, the agent's own page, served as is on an origin of its own
// (views/page/), as are `ah tool tracker`'s task lists and `ah tool stack`'s
// stacks of PRs. Showing, listing and closing (subjects/files/), the thread
// (subjects/thread/) and the dashboard record are the same for both.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { text } from "node:stream/consumers"
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
import { mergeDisk } from "./doc/merge.ts"
import { dashboard } from "./dashboard/cli.ts"
import { docFormat } from "./doc/doc.ts"
import { openable, rootFinder } from "../core/workspace.ts"
import { sendToTab } from "../core/send.ts"
import {
  setCurrentTracker,
  setTrackerStatus,
  workspaceTrackers,
} from "../core/tracker_api.ts"
import { taskListPage } from "./page/task_list_file.ts"
import { STACK_FILE } from "./page/stack_data.ts"
import { stackJson, stackPage } from "./page/stack_file.ts"

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
  if (!title || !goal) die("ah tool tracker add: a new task list needs --title and --goal")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, taskListPage(title, goal))
  console.log(`wrote ${absolute(file)}`)
}

/** Write a new stack's page and its stack.json, unless the page is there */
function ensureStack(file: string, title?: string) {
  if (existsSync(file)) return
  if (!/\.html$/i.test(file)) die(`no such file: ${file}`)
  if (!title) die("ah tool stack: a new stack needs --title")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stackPage(title))
  console.log(`wrote ${absolute(file)}`)
  const json = join(dirname(file), STACK_FILE)
  if (existsSync(json)) return
  writeFileSync(json, stackJson(title))
  console.log(`wrote ${absolute(json)}`)
}

/** Any URL, like a diff review tool's page: shown in a window or
 * tab like a file's page, but with no subject ah knows, so nothing is bound
 * and there's no thread. Whatever serves it can talk to agents itself, with
 * `ah message send`. */
const isUrl = (arg: string) => /^https?:\/\//i.test(arg) && URL.canParse(arg)

/** Show a file in its tool's page, bound to this agent */
async function openFile(
  path: string,
  place: "window" | "tab",
  port: number,
  params: Record<string, string> = {},
) {
  const { url, views } = await showInServer(fileKind(path), port, path)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  await showPage(place, url, path, views)
}

const BINDING =
  "Comments go to the agent session this command runs in, or run from a shell in Rex, to an agent in its tab, which it asks you to pick if there are several; the file stays bound to that agent until another opens it. A window or tab comes to the front when run from a shell, or from an agent whose Rex pane has focus with Rex the frontmost app; otherwise it opens without taking focus. A file already shown in a window keeps that window, which comes to the front under the same rule. Prints the page's URL, which keeps working across server restarts."

const doc = new Command("doc")
  .summary("A markdown or AsciiDoc file to write with the agent")
  .description(
    "A markdown or AsciiDoc file, rendered like GitHub, with a helix pane and comments and chat that go to the agent. `ah tool doc <file>` is short for `ah tool doc open <file>`, except for a file named like a command here.",
  )

doc
  .command("open", { isDefault: true })
  .summary("Open a doc's page")
  .description(
    `Open a markdown or AsciiDoc file in a page you can comment on; \`ah tool doc <file>\` does the same. .adoc and .asciidoc files are rendered as AsciiDoc, and any other file as markdown. ${BINDING}`,
  )
  // Optional so that `ah tool doc` alone, which comes here as the default,
  // shows the help rather than a missing argument
  .argument("[file]")
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
  .option("--no-editor", "The preview only, without the helix pane")
  .option("--no-chat", "Without the conversation")
  .option(
    "--diff-from [revset]",
    "Show the file's changes since a jj revision, by default the working copy's parent, @-. ⌘D on the page does the same, and B picks the revision.",
  )
  .addOption(portOption())
  .action(async (file, { in: place, editor, chat, diffFrom, port }) => {
    if (!file) return doc.help()
    const path = openablePathOrDie(file)
    if (fileKind(path) === "page") die(`ah tool doc: ${file} is HTML; use ah tool page`)
    const glow = place === "split" || place === "float" || place === "here"
    if (glow && docFormat(path) === "asciidoc") {
      die(`ah tool doc --in ${place}: glow only shows markdown`)
    }
    // glow's TUI watches the file itself and keeps scroll position across reloads
    if (place === "split") {
      const block =
        process.env.REX_BLOCK ?? die("ah tool doc --in split: not running in Rex")
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
        process.env.REX_SESSION ?? die("ah tool doc --in float: not running in Rex")
      const block =
        process.env.REX_BLOCK ?? die("ah tool doc --in float: not running in Rex")
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
    await openFile(path, place, port, {
      ...(!editor && { editor: "off" }),
      ...(!chat && { chat: "off" }),
      ...(diffFrom !== undefined && { "diff-from": diffFrom === true ? "" : diffFrom }),
    })
  })

doc
  .command("merge")
  .summary("Merge the file on disk into an editor's unsaved text")
  .description(
    'For editors that take the agent\'s edits by merging rather than reloading when you have unsaved edits. Reads JSON {"base", "unsaved", "disk"} on stdin: the file as the editor last read or saved it, the editor\'s text, and the file now. Merges disk into unsaved by lines, marking lines both changed with git\'s conflict markers, or with --words word by word, as the doc page\'s editor pane does. Prints JSON {"text", "conflicts"}: the merged text and how many conflicts it marked. Reads all of stdin before writing anything. Doesn\'t need the server.',
  )
  .option(
    "--words",
    "merge word by word, marking conflicts within a line with CriticMarkup",
  )
  .action(async ({ words }) => {
    const { base, unsaved, disk } = JSON.parse(await text(process.stdin))
    if (![base, unsaved, disk].every((t) => typeof t === "string"))
      throw new Error("expected base, unsaved and disk as strings")
    console.log(JSON.stringify(mergeDisk(base, unsaved, disk, words ? "words" : "lines")))
  })

const page = new Command("page")
  .summary("An HTML page the agent wrote, or any URL")
  .description(
    `Open an HTML file as it is, with comments and chat that go to the agent. ${BINDING}\n\nGiven an http(s) URL instead of a file, open it in a window named --name or a tab. Nothing is bound to it and it has no conversation. The URL can come last, so a tool can append it to \`ah tool page --name <name>\`.`,
  )
  .argument("<file>", "an HTML file, or any http(s) URL")
  .addOption(
    new Option(
      "--in <place>",
      "window: a window of its own, with its own Dock tile; tab: the default browser",
    )
      .choices(["window", "tab"] as const)
      .default("window" as const),
  )
  .option("--no-chat", "Without the conversation")
  .option(
    "--name <name>",
    "A URL's window: what the Dock calls it (default: the URL's hostname). Each name makes a copy of the window app, so keep it stable.",
  )
  .addOption(portOption())
  .action(async (file, { in: place, chat, name, port }) => {
    if (isUrl(file)) {
      const dockName = name ?? new URL(file).hostname
      await showUrl(place, file, {
        name: dockName,
        badge: dockName.charAt(0).toUpperCase(),
        color: "#475569",
      })
      return console.log(file)
    }
    if (name !== undefined)
      die("ah tool page --name: URLs only; a file's window is named after it")
    const path = openablePathOrDie(file)
    if (fileKind(path) !== "page") die(`ah tool page: ${file} isn't HTML; use ah tool doc`)
    await openFile(path, place, port, chat ? {} : { chat: "off" })
  })

const stack = new Command("stack")
  .summary("A stack of PRs: their commits, diff stats and summaries")
  .description(
    `Open a stack's page: the PRs listed in the stack.json next to it, newest first, each with its commits and diff stats from jj, redrawn when a jj operation lands. Each diff stat is a button that opens that commit's or PR's diff in skepsis, whose comments go to the agent the page is bound to; AH_SKEPSIS in the server's environment is the command that runs skepsis, else skepsis on PATH. If the file isn't there, ah writes it and a stack.json to fill in, which needs --title. By convention a stack goes at .claude/notes/<date>-<slug>-stack/index.html. ${BINDING}`,
  )
  .argument("<file>")
  .option("--title <title>", "A new stack's title")
  .addOption(portOption())
  .action(async (file, { title, port }) => {
    ensureStack(file, title)
    await openFile(openablePathOrDie(file), "window", port)
  })

export const windows = new Command("window")
  .summary("The windows and tabs tools are open in")
  .description(
    "The windows and browser tabs ah's tools are open in, and the dashboard's slot",
  )
  .action(function () {
    this.help()
  })

windows
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

windows
  .command("close")
  .summary("Close the windows showing a file")
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

const tracker = new Command("tracker")
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
      if (!(await status(port))) die(`ah tool tracker ${name}: server not running`)
      console.log(`${to}: ${await setTrackerStatus(port, resolve(file), to)}`)
    })
}

export const tool = new Command("tool")
  .summary("Open one of ah's tools: a doc, a page, a tracker, a stack, or the dashboard")
  .description(
    "ah's tools, each a page whose comments and buttons talk back to agent sessions",
  )
  .action(function () {
    this.help()
  })
for (const command of [doc, page, tracker, stack, dashboard]) tool.addCommand(command)
