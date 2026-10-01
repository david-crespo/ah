// `ah app <name> respond` and `ah app <name> pending`: how the agent answers a
// thread, for any app whose pages have one

import { readFileSync } from "node:fs"
import { Argument, Command } from "@commander-js/extra-typings"
import { die, ensureStarted, portOption, serverJson } from "../cli.ts"
import { absolute } from "../files/cli.ts"
import { type FeedSnapshot, PHASES } from "./events.ts"

/** `threadUrl` is where the file's thread takes the agent's events on that port */
export function threadCommands(
  app: string,
  threadUrl: (path: string, port: number) => string,
) {
  const notOpen = (path: string, file: string) =>
    die(`ah: ${path} isn't open; open it with \`ah app ${app} open ${file}\``)
  const snapshot = async (url: string, path: string, file: string) => {
    const res = await fetch(url)
    if (res.status === 404) notOpen(path, file)
    if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
    return serverJson<FeedSnapshot>(res)
  }

  const pending = new Command("pending")
    .description(
      "List the file's requests not done yet, one JSON line each with its status",
    )
    .argument("<file>")
    .addOption(portOption())
    .action(async (file, { port }) => {
      const path = absolute(file)
      await ensureStarted(port)
      const { events, requests } = await snapshot(threadUrl(path, port), path, file)
      const byId = new Map(events.map((e) => [e.id, e]))
      for (const state of requests) {
        if (state.status === "done") continue
        const event = byId.get(state.id)
        if (!event) continue
        console.log(JSON.stringify({ ...event, status: state.status }))
      }
    })

  const respond = new Command("respond")
    .description("Answer the file's comments: post a phase for requests, shown on the page")
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
      const post = async (body: object) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (res.status === 404 && (await res.clone().text()) === "not found") {
          notOpen(path, file)
        }
        if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
      }
      // Quick work can skip `start`: anything that ends or updates work starts
      // it first if this attempt hasn't
      if (requests.length && phase !== "start" && phase !== "reply") {
        const { requests: states } = await snapshot(url, path, file)
        const started = requests.every((id) =>
          states.some((s) => s.id === id && s.status === "working" && s.workId === workId),
        )
        if (!started) await post({ phase: "start", requestIds: requests, workId })
      }
      const text = textFile ? readFileSync(textFile, "utf8").trimEnd() : inlineText
      await post({ phase, requestIds: requests, workId, text })
      console.log([phase, ...requests].join(" "))
    })

  return [respond, pending]
}
