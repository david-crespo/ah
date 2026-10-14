// `ah app markdown`

import { spawn } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
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
import { currentAgent } from "../../host/session.ts"
import {
  clearSessionFile,
  clearShownFile,
  ensureDashboardPage,
  sessionFile,
  sessionRoot,
  showFile,
  shownFiles,
} from "../dashboard/api.ts"
import { fileId } from "../../host/id.ts"

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

export const markdown = new Command("markdown")
  .description("Markdown files with a live preview, review comments, and a helix pane")
  .action(function () {
    this.help()
  })

markdown
  .command("open")
  .description("Open a file, bound to the agent session this runs in so comments go to it")
  .argument("<file>")
  .addOption(
    new Option(
      "--in <place>",
      [
        "window: a Chrome app window; tab: the default browser;",
        "dashboard: as this session's file in the dashboard, until the session ends or it's closed,",
        "opening a dashboard page if none is open;",
        "split: glow in a new Rex split 35% above this terminal, focus staying put;",
        "here: glow in this terminal",
      ].join(" "),
    )
      .choices(["window", "tab", "dashboard", "split", "here"] as const)
      .default("window" as const),
  )
  .option("--no-editor", "Preview only, without the helix pane")
  .option("--no-chat", "Without the comment conversation")
  .addOption(portOption())
  .action(async (file, { in: place, editor, chat, port }) => {
    const path = realPathOrDie(file)
    if (place === "dashboard") {
      // A record, not a call to the server: the dashboard picks it up
      // whenever it runs, and it lapses with the session
      const agent =
        currentAgent() ??
        die("ah app markdown open --in dashboard: not running in an agent session")
      showFile(agent, path)
      console.log(`in the dashboard: ${path}`)
      return console.log(await ensureDashboardPage(port))
    }
    // glow's TUI watches the file itself and keeps scroll position across reloads
    if (place === "split") {
      const block =
        process.env.REX_BLOCK ?? die("ah app markdown open --in split: not running in Rex")
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
    const url = await openInServer("markdown", port, path)
    if (!editor) url.searchParams.set("editor", "off")
    if (!chat) url.searchParams.set("chat", "off")
    await showPage(place, url)
  })

markdown
  .command("ls")
  .description(
    "Files live sessions show in the dashboard, newest first, then files the server has open, oldest first",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    for (const r of shownFiles()) {
      console.log(["dashboard", r.key, r.root, r.file].join("\t"))
    }
    await printOpenFiles("markdown", port)
  })

markdown
  .command("close")
  .description(
    "Stop showing a file anywhere: in the dashboard and in the server; without one, this session's file in the dashboard",
  )
  .argument("[file]")
  .addOption(portOption())
  .action(async (file, { port }) => {
    let path: string
    if (file) {
      // The file may be gone by now
      path = absolute(file)
      clearShownFile(path)
    } else {
      const agent =
        currentAgent() ??
        die("ah app markdown close: not in an agent session, pass the file")
      const current = sessionFile(agent)
      if (!current) return console.error("ah: this session has nothing in the dashboard")
      path = current
      clearSessionFile(agent)
    }
    console.log(`closed ${path}`)
    // Not open in the server, or no server, is fine: it may only have been
    // in the dashboard
    await closeInServer("markdown", port, path)
  })

for (const command of threadCommands(
  "markdown",
  (path, port) => `http://127.0.0.1:${port}/app/markdown/${fileId(path)}/activity`,
)) {
  markdown.addCommand(command)
}
