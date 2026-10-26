// `ah message respond` and `ah message pending`: how the agent answers a
// page's thread; and `ah message send`, the user's comment from their editor
// or a diff review, as a plain message to an agent in the Rex tab
// (core/send.ts) or, from a markdown page's helix pane, into the file's
// thread

import { existsSync, readFileSync } from "node:fs"
import { Argument, Command } from "@commander-js/extra-typings"
import {
  callServer,
  die,
  ensureStarted,
  portOption,
  readStdin,
} from "../../platform/cli.ts"
import { absolute } from "../files/cli.ts"
import { type RequestResult, type ThreadSnapshot, PHASES } from "./events.ts"

/** `fileUrl` is where the file's `thread` takes the agent's events, and its
 * `request` route takes requests from outside the page, on that port.
 * `sendToTab` sends a plain message to an agent in a Rex tab (core/send.ts). */
export function threadCommands(
  fileUrl: (path: string, port: number, route: "thread" | "request") => string,
  sendToTab: (
    port: number,
    block: string | null,
    agent: string | null,
    text: string,
  ) => Promise<"sent" | "held">,
) {
  const threadUrl = (path: string, port: number) => fileUrl(path, port, "thread")
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
      const text = replyText(inlineText, textFile && readFileSync(textFile, "utf8"))
      if (text === null)
        die(
          "ah message respond: the text is empty; leave out --text and --text-file for none",
        )
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
      await post({ phase, requests, workId, text })
      console.log([phase, ...requests].join(" "))
    })

  const send = new Command("send")
    .summary("Send the user's comment to an agent")
    .description(
      [
        "Send the user's comment to an agent, as their editor or a diff review does. The text is --text, --text-file, or stdin.",
        "In a Rex pane, or with --agent, it's a plain message. It goes to --agent if given, which also becomes this pane's pick for later sends; else to the pane's pick, or the tab's only agent. With several agents in the tab and no pick, it refuses and lists them (`ah workspace agents`). With no agent there, it waits for the next one in the tab, unless the pane closes first. With --file, ah writes the message: the file, the lines and the selection, then the text; without it, the text goes as it is, as a diff review sends its prompt.",
        "Outside Rex, as in a markdown page's helix pane, --file is required and the comment goes into the file's thread, as one made on its page: on the selection, or the lines, or the whole file without either. It goes to the agent the file is bound to, or waits for one.",
        "Prints `sent`, or `held` when it waits; on a thread, with the request's id.",
      ].join("\n\n"),
    )
    .option("--file <path>", "The file the comment is on")
    .option("--lines <n|n-m>", "The lines of --file it's on, 1-based")
    .option("--selection <text>", "The text the user selected, if any")
    .option(
      "--agent <id>",
      "The agent it's for, by id (see `ah workspace agents`); later sends from this pane go to it too",
    )
    .option("--text <text>", "The comment")
    .option("--text-file <path>", "Read the comment from a file")
    .addOption(portOption())
    .action(async (opts) => {
      const { agent, selection, text: inline, textFile, port } = opts
      const text = (
        inline ?? (textFile ? readFileSync(textFile, "utf8") : await readStdin())
      )?.trim()
      if (!text) die("ah message send: no comment; give --text, --text-file, or stdin")
      const path = opts.file === undefined ? null : absolute(opts.file)
      if (path && !existsSync(path)) die(`ah: no such file: ${opts.file}`)
      const lines = opts.lines === undefined ? null : parseLines(opts.lines)
      if (lines && !path) die("ah message send: --lines needs --file")
      const block = process.env.REX_BLOCK ?? null
      if (block || agent) {
        const message = path ? comment(path, lines, selection ?? null, text) : text
        const status = await sendToTab(port, block, agent ?? null, message)
        return console.log(
          status === "sent"
            ? "sent"
            : "held: no agent here to take it; it goes to the next one",
        )
      }
      if (!path) die("ah message send: not in a Rex pane, so give --file or --agent")
      // A comment on the page quotes what it's on; from the lines, the lines
      const quoted = selection ?? (lines ? linesOf(path, lines) : "")
      await ensureStarted(port)
      const { request, agentConnected } = await callServer<RequestResult>(
        fileUrl(path, port, "request"),
        {
          body: quoted
            ? { kind: "comment", text, args: { selection: quoted } }
            : { kind: "chat", text, args: {} },
        },
      )
      console.log(`${agentConnected ? "sent" : "held"} ${request.id}`)
    })

  return [send, respond, pending]
}

type Lines = [first: number, last: number]

function parseLines(arg: string): Lines {
  const match = /^(\d+)(?:-(\d+))?$/.exec(arg)
  const first = Number(match?.[1])
  const last = Number(match?.[2] ?? first)
  if (!match || first < 1 || last < first) die(`ah: --lines takes n or n-m, not ${arg}`)
  return [first, last]
}

/** The lines of the file on disk, trimmed */
function linesOf(path: string, [first, last]: Lines): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(first - 1, last)
    .join("\n")
    .trim()
}

/** A reply's text from --text or the --text-file's contents: undefined with
 * neither, null when one was given but is blank, which is a mistake (a file
 * not written yet, or empty stdin) rather than a reply with no text */
export function replyText(
  inline: string | undefined,
  fromFile: string | undefined,
): string | null | undefined {
  const text = fromFile ?? inline
  if (text === undefined) return undefined
  return text.trim() ? text.trimEnd() : null
}

/** What the agent reads for a comment on lines of path, or the whole file */
export function comment(
  path: string,
  lines: Lines | null,
  selection: string | null,
  text: string,
): string {
  const place = !lines
    ? path
    : lines[0] === lines[1]
      ? `line ${lines[0]} of ${path}`
      : `lines ${lines[0]}-${lines[1]} of ${path}`
  const quote = selection
    ? `, selecting:\n\`\`\`\n${selection.trimEnd()}\n\`\`\`\n\n`
    : ":\n\n"
  return `A comment from the user on ${place}${quote}${text}`
}
