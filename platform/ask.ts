// Asking the person, in a sheet on a page's window, before ah does something
// only they may allow, like the stack page's push. ah's pages share one
// origin, so any page's script could ask for such a thing; the sheet is
// AppKit, drawn by the window app (webview/main.swift), which no page's
// script can click. The server asks over the Unix socket the window was
// started with (window.ts) and reads the answer on the same connection.
// Pages can only reach TCP ports, so none can answer or listen in, and the
// app's text fields show the question's text as plain strings.

import { createConnection } from "node:net"
import { activatePid } from "./focus.ts"
import { windowOf } from "./window.ts"

/** A heading, lines under it, then rows of an ID and a line of text, with
 * how many more rows there are; `button` says yes next to Cancel */
export interface Question {
  heading: string
  notes: string[]
  rows: { id: string; text: string }[]
  more: number
  button: string
}

/** Whether the person said yes to `question` in the window showing `page`;
 * null when no window of ah's shows it */
export type Confirm = (page: URL, question: Question) => Promise<boolean | null>

export const confirmInWindow: Confirm = async (page, question) => {
  const window = windowOf(page)
  if (!window) return null
  const answer = ask(window.socket, question)
  // The sheet is on its window, so that comes forward
  const failed = await activatePid(window.pid)
  if (failed) console.error(`ah: couldn't bring the window forward: ${failed}`)
  return await answer
}

/** The app gives up after 2 minutes; this, a little after, in case it can't */
const GIVE_UP = 125_000

/** Whether the app listening at `socket` answered yes to `question`. Any
 * failure, or no answer by `giveUp` ms, is a no. */
export function ask(
  socket: string,
  question: Question,
  giveUp = GIVE_UP,
): Promise<boolean> {
  return new Promise((resolve) => {
    let reply = ""
    const conn = createConnection(socket)
    const done = (yes: boolean) => {
      clearTimeout(timer)
      conn.destroy()
      resolve(yes)
    }
    const timer = setTimeout(() => done(false), giveUp)
    conn.setEncoding("utf8")
    conn.on("connect", () => conn.write(`${JSON.stringify(question)}\n`))
    conn.on("data", (chunk: string) => {
      reply += chunk
      if (reply.includes("\n")) done(reply.split("\n")[0] === "yes")
    })
    conn.on("error", (e) => {
      console.error(`ah: couldn't ask in the window: ${e.message}`)
      done(false)
    })
    conn.on("close", () => done(false))
  })
}
