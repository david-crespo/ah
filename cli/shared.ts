// What every group's commands share: the port, starting the server, reading
// the server's responses, and erroring out.

import { styleText } from "node:util"
import select from "@inquirer/select"
import { InvalidArgumentError, Option } from "@commander-js/extra-typings"
import { DEFAULT_PORT, ensureServer } from "../platform/server.ts"

/** Start the server unless it's running; returns the running one's pid, if any */
export async function ensureStarted(port: number): Promise<number | null> {
  try {
    return await ensureServer(port)
  } catch (e) {
    // A sandbox that blocks localhost makes the server look down, and then
    // blocks starting one too
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e
    die(`ah: can't reach or start the server on port ${port} (in a sandbox?): ${e}`)
  }
}

/** `route` on the server at `port`, like `core/trackers` */
export const serverUrl = (port: number, route: string) =>
  `http://127.0.0.1:${port}/${route}`

/** Call a server route, sending `body` as JSON if given (a POST, unless
 * `method` says otherwise), and return what it sends back. A non-2xx
 * response exits with its body. */
export async function callServer<T>(
  url: string | URL,
  { method, body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  })
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return await serverJson<T>(res)
}

/** A response body from ah's own server, as the type its route sends. The
 * CLI and the server ship together, so it isn't checked. */
async function serverJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Stdin, all of it, when it's piped */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export function die(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseInteger(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new InvalidArgumentError("Not an integer.")
  return n
}

/** `-p, --port`, on every command that starts or talks to the server */
export const portOption = (description = "Port the server is on") =>
  new Option("-p, --port <port>", description).argParser(parseInteger).default(DEFAULT_PORT)

/** Let the user pick one of `choices` in the terminal, or null if they quit
 * with q, Ctrl+C, or Ctrl+D. Draws on stderr, since stdout is for a page's
 * URL. */
export async function pickOne<T>(
  message: string,
  choices: { name: string; value: T }[],
): Promise<T | null> {
  // q quits, which select has no key for
  const quit = new AbortController()
  const onKey = (_: string, key?: { name?: string }) => {
    if (key?.name === "q") quit.abort()
  }
  process.stdin.on("keypress", onKey)
  try {
    return await select(
      {
        message,
        choices,
        theme: {
          // j and k move too
          keybindings: ["vim"],
          style: {
            keysHelpTip: (keys: [string, string][]) =>
              [...keys, ["q", "quit"]]
                .map(([k, action]) => `${styleText("bold", k)} ${styleText("dim", action)}`)
                .join(styleText("dim", " • ")),
          },
        },
      },
      { output: process.stderr, signal: quit.signal },
    )
  } catch (e) {
    if (e instanceof Error && ["AbortPromptError", "ExitPromptError"].includes(e.name)) {
      return null
    }
    throw e
  } finally {
    process.stdin.off("keypress", onKey)
  }
}
