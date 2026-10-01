// `ah app dashboard`

import { Command, Option } from "@commander-js/extra-typings"
import { portOption } from "../../host/cli.ts"
import { ensureDashboardPage } from "./api.ts"

export const dashboard = new Command("dashboard")
  .description("The page that follows the focused Ghostty tab's jj workspace")
  .action(function () {
    this.help()
  })

dashboard
  .command("open")
  .description("Open the dashboard unless it's already open")
  .addOption(
    new Option("--in <place>", "window: a Chrome app window")
      .choices(["window"])
      .default("window"),
  )
  .option(
    "--no-other-display",
    "Leave the window where Chrome puts it, instead of on a display without the pointer",
  )
  .addOption(portOption())
  .action(async ({ port, otherDisplay }) => {
    console.log(await ensureDashboardPage(port, otherDisplay))
  })
