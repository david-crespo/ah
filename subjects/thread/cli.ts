// `ah request respond` and `ah request pending`: how the agent answers a
// page's thread

import { readFileSync } from "node:fs"
import { Argument, Command } from "@commander-js/extra-typings"
import { callServer, ensureStarted, portOption } from "../../platform/cli.ts"
import { absolute } from "../files/cli.ts"
import { type ThreadSnapshot, PHASES } from "./events.ts"

/** `threadUrl` is where the file's thread takes the agent's events on that port */
export function threadCommands(threadUrl: (path: string, port: number) => string) {
  const snapshot = (url: string) => callServer<ThreadSnapshot>(url)

  const pending = new Command("pending")
    .summary("List a file's requests that aren't done")
    .description(
      "List a file's requests that aren't done, one JSON line each, with its status.",
    )
    .argument("<file>")
    .addOption(portOption())
    .action(async (file, { port }) => {
      const path = absolute(file)
      await ensureStarted(port)
      const { entries, requests } = await snapshot(threadUrl(path, port))
      const byId = new Map(entries.map((e) => [e.id, e]))
      for (const state of requests) {
        if (state.status === "done") continue
        const request = byId.get(state.id)
        if (!request) continue
        console.log(JSON.stringify({ ...request, status: state.status }))
      }
    })

  const respond = new Command("respond")
    .summary("Reply to requests on a file")
    .description(
      "Reply to requests on a file by posting a phase for one or more requests. The page shows the phase. To reply without answering a specific request, give no request ids.",
    )
    .argument("<file>")
    .addArgument(new Argument("<phase>").choices(PHASES))
    .argument("[requests...]", "Request ids the work covers; none for a standalone reply")
    .option(
      "--work <id>",
      "Id for this attempt at the requests; defaults to one derived from the first request",
    )
    .option("--text <text>", "Reply, summary, or question, in markdown")
    // The `ah *` sandbox exclusion only covers a one-line command, without
    // redirects, so a long reply goes through a file rather than stdin
    .option("--text-file <path>", "Read the text from a file")
    .addOption(portOption())
    .action(async (file, phase, requests, { work, text: inlineText, textFile, port }) => {
      const path = absolute(file)
      const url = threadUrl(path, port)
      await ensureStarted(port)
      const workId = requests.length ? (work ?? `w-${requests[0]}`) : work
      const post = (body: object) => callServer(url, { body })
      // Quick work can skip `start`: anything that ends or updates work starts
      // it first if this attempt hasn't
      if (requests.length && phase !== "start" && phase !== "reply") {
        const { requests: states } = await snapshot(url)
        const started = requests.every((id) =>
          states.some((s) => s.id === id && s.status === "working" && s.workId === workId),
        )
        if (!started) await post({ phase: "start", requests, workId })
      }
      const text = textFile ? readFileSync(textFile, "utf8").trimEnd() : inlineText
      await post({ phase, requests, workId, text })
      console.log([phase, ...requests].join(" "))
    })

  return [respond, pending]
}
