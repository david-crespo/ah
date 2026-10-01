// `ah app html`

import { realpathSync } from "node:fs"
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

export const html = new Command("html")
  .description(
    "HTML files an agent wrote, served as is with live reload and a conversation with the agent",
  )
  .action(function () {
    this.help()
  })

html
  .command("open")
  .description(
    "Open an HTML file, bound to the agent session this runs in so comments go to it",
  )
  .argument("<file>")
  .addOption(
    new Option("--in <place>", "window: a Chrome app window; tab: the default browser")
      .choices(["window", "tab"] as const)
      .default("window" as const),
  )
  .option("--no-chat", "Live reload only, without the conversation")
  .addOption(portOption())
  .action(async (file, { in: place, chat, port }) => {
    let path: string
    try {
      path = realpathSync(file)
    } catch {
      die(`no such file: ${file}`)
    }
    const url = await openInServer("html", port, path)
    if (!chat) url.searchParams.set("chat", "off")
    await showPage(place, url)
  })

html
  .command("ls")
  .description("Files the server has open, oldest first")
  .addOption(portOption())
  .action(async ({ port }) => {
    await printOpenFiles("html", port)
  })

html
  .command("close")
  .description("Stop serving a file; its pages say it's closed")
  .argument("<file>")
  .addOption(portOption())
  .action(async (file, { port }) => {
    const path = absolute(file)
    const result = await closeInServer("html", port, path)
    if (result === "no server") return console.error("ah: server not running, nothing open")
    if (result === "not open") return console.error(`ah: ${path} isn't open`)
    console.log(`closed ${path}`)
  })

for (const command of threadCommands(
  "html",
  (path, port) => `http://127.0.0.1:${port}/app/html/${fileId(path)}/_ah/activity`,
)) {
  html.addCommand(command)
}
