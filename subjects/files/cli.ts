// What the commands of every backend for files share: binding a file in the
// server and showing its page, listing what pages show, and closing a file's
// windows.

import { realpathSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { styleText } from "node:util"
import select from "@inquirer/select"
import { callServer, die, ensureStarted, serverUrl } from "../../platform/cli.ts"
import { focusHere, keepFocus } from "../../platform/focus.ts"
import { openWindow, windowName } from "../../platform/window.ts"
import { run } from "../../platform/proc.ts"
import { currentAgent, currentAddress } from "../../platform/session.ts"
import { status } from "../../platform/server.ts"
import {
  type AgentId,
  type FileKind,
  type NearbyAgent,
  fileKind,
} from "../../core/model.ts"
import type { FileInfo, Location } from "./files.ts"
import type { ShowRequest } from "./routes.ts"

/** The real path, or the absolute one for a file that may be gone */
export function absolute(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return resolvePath(file)
  }
}

const filesUrl = (kind: FileKind, port: number) => serverUrl(port, `view/${kind}/files`)

/** Bind `path` to the agent this runs in, or from a shell in Rex, an agent
 * in its tab; the URL of its page, and where pages already show it */
export async function showInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<{ url: URL; views: Location[] }> {
  const address = currentAddress()
  await ensureStarted(port)
  const request: ShowRequest = address
    ? { path, address, agent: currentAgent(address) }
    : { path, address, agentId: await pickAgentNear(port) }
  const opened = await callServer<FileInfo>(filesUrl(kind, port), { body: request })
  return { url: new URL(opened.url, serverUrl(port, "")), views: opened.views }
}

/** A nearby agent as its tab's title has it */
const agentLine = (a: NearbyAgent) =>
  [a.label, a.summary].filter(Boolean).join(" | ") +
  ` (${a.harness}${a.busy ? ", working" : ""})`

/** From a shell in no agent session: the agent in its Rex tab, or if
 * there are several, the one the user picks. Picking takes a terminal, so
 * without one, several is an error. */
async function pickAgentNear(port: number): Promise<AgentId | null> {
  const block = process.env.REX_BLOCK
  const none = "ah: not in an agent session or a tab with one; comments won't go anywhere"
  if (!block) return (console.error(none), null)
  const agents = await callServer<NearbyAgent[]>(
    serverUrl(port, `core/agents-near?block=${encodeURIComponent(block)}`),
  )
  if (agents.length <= 1) {
    console.error(agents[0] ? `ah: comments go to ${agentLine(agents[0])}` : none)
    return agents[0]?.id ?? null
  }
  if (!process.stdin.isTTY) {
    const list = agents.map((a) => `  ${agentLine(a)}`).join("\n")
    die(`ah: this tab has ${agents.length} agents; run in a terminal to pick one:\n${list}`)
  }
  // q quits, which select has no key for
  const quit = new AbortController()
  const onKey = (_: string, key?: { name?: string }) => {
    if (key?.name === "q") quit.abort()
  }
  process.stdin.on("keypress", onKey)
  try {
    return await select(
      {
        message: "Which agent gets comments?",
        choices: agents.map((a) => ({ name: agentLine(a), value: a.id })),
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
      // stdout is for the page's URL
      { output: process.stderr, signal: quit.signal },
    )
  } catch (e) {
    // q, Ctrl+C, or Ctrl+D
    if (e instanceof Error && ["AbortPromptError", "ExitPromptError"].includes(e.name)) {
      die("ah: no agent picked, nothing shown")
    }
    throw e
  } finally {
    process.stdin.off("keypress", onKey)
  }
}

/** `path`'s page in a window of its own or a tab of the default browser,
 * taking focus only as `focusHere` allows. With `shown` saying a window
 * already shows it, that window comes forward instead. */
export async function showPage(
  place: "window" | "tab",
  url: URL,
  path: string,
  shown: Location[],
) {
  // Its socket says so, for `ah view ls`
  url.searchParams.set("in", place)
  const focus = await focusHere()
  if (place === "window") {
    const name = windowName(path)
    const html = fileKind(path) === "html"
    await openWindow(
      url.href,
      { name, badge: name.charAt(0).toUpperCase(), color: html ? "#d97706" : "#0d9488" },
      focus,
      shown.includes("window"),
    )
  } else if (focus.take) {
    await run("open", [url.href])
  } else {
    await run("open", ["-g", url.href])
    await keepFocus(focus.front)
  }
  console.log(url.href)
}

/** The files pages of the backend for `kind` show, oldest first; the server
 * must be running */
export const shownFiles = (kind: FileKind, port: number) =>
  callServer<FileInfo[]>(filesUrl(kind, port))

/** A file as `ah view ls` prints it: id, path, where its pages are, agent,
 * and where its comments go */
export function fileLine(f: FileInfo): string {
  const address = f.address ? `${f.address}${f.addressAlive ? "" : " (gone)"}` : "-"
  const views = f.views.length ? f.views.join(",") : "-"
  return [f.id, f.path, views, f.agent ?? "-", address].join("\t")
}

/** Close the windows and tabs that show the file */
export async function closeInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<"closed" | "not shown" | "no server"> {
  if (!(await status(port))) return "no server"
  const query = new URLSearchParams({ path })
  const res = await fetch(`${filesUrl(kind, port)}?${query}`, { method: "DELETE" })
  if (res.status === 404) return "not shown"
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return "closed"
}
