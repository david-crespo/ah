// `ah window`, and what every command that shows a file shares: its path,
// binding it in the server (/view/<kind>/files) and showing its page, its
// thread's URL, and listing what pages show and closing a file's windows.

import { realpathSync, statSync } from "node:fs"
import { join, relative, resolve as resolvePath } from "node:path"
import { Command } from "@commander-js/extra-typings"
import { callServer, die, ensureStarted, portOption, serverUrl } from "./shared.ts"
import { pickAgentNear } from "./agents.ts"
import { showUrl, windowName } from "../platform/window.ts"
import { currentAgent, currentAddress } from "../platform/session.ts"
import { status } from "../platform/server.ts"
import { openable, rootFinder } from "../core/workspace.ts"
import { FILE_KINDS, type FileKind, fileKind } from "../model.ts"
import type { FileInfo, Location } from "../subjects/files/files.ts"
import type { ShowRequest } from "../subjects/files/routes.ts"

/** The real path, or the absolute one for a file that may be gone */
export function absolute(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return resolvePath(file)
  }
}

/** `realPathOrDie`, for a file to serve: under the cwd or its workspace */
export function openablePathOrDie(file: string): string {
  const path = realPathOrDie(file)
  if (!openable(path, process.cwd())) {
    die(`ah: ${path} is outside this directory and its jj workspace, so ah won't serve it`)
  }
  return path
}

/** The file's real path, or exit with a hint if it's only in the notes dir */
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

const filesUrl = (kind: FileKind, port: number) => serverUrl(port, `view/${kind}/files`)

/** Where the file's thread takes the agent's events, or requests from
 * outside its page */
export const fileUrl = (path: string, port: number, route: "thread" | "request") =>
  `${filesUrl(fileKind(path), port)}/${route}?path=${encodeURIComponent(path)}`

/** Bind `path` to the agent this runs in, or from a shell in Rex, an agent
 * in its tab; the URL of its page, and where pages already show it */
export async function showInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<{ url: URL; views: Location[] }> {
  const address = currentAddress()
  await ensureStarted(port)
  const agentId = address ? null : await pickAgentNear(port)
  const request: ShowRequest = address
    ? { path, address, agent: currentAgent(address) }
    : { path, address, agentId }
  const opened = await callServer<FileInfo>(filesUrl(kind, port), { body: request })
  if (!address && !agentId) {
    console.error(
      `ah: not in an agent session or a tab with one; ${whereCommentsGo(opened)}`,
    )
  }
  return { url: new URL(opened.url, serverUrl(port, "")), views: opened.views }
}

/** Where the server routes a file's comments, for one shown with no agent
 * to bind it to */
function whereCommentsGo({ address, addressAlive, via }: FileInfo): string {
  // A live address always has a route
  if (!addressAlive || !via)
    return "no agent can take comments now, so they queue for the next one"
  switch (via) {
    case "agent":
      return `comments go to ${address}, the agent this file is bound to`
    case "tab":
      return `this file's agent is gone, so comments go to ${address} in its tab`
    case "workspace":
      return `comments go to ${address}, an agent in this file's workspace`
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
  // Its socket says so, for `ah window ls`
  url.searchParams.set("in", place)
  const name = windowName(path)
  const html = fileKind(path) === "page"
  await showUrl(
    place,
    url.href,
    { name, badge: name.charAt(0).toUpperCase(), color: html ? "#d97706" : "#0d9488" },
    shown.includes("window"),
  )
}

/** The files pages of the backend for `kind` show, oldest first; the server
 * must be running */
const shownFiles = (kind: FileKind, port: number) =>
  callServer<FileInfo[]>(filesUrl(kind, port))

/** A file as `ah window ls` prints it: id, path, where its pages are, agent,
 * and where its comments go */
function fileLine(f: FileInfo): string {
  const address = f.address ? `${f.address}${f.addressAlive ? "" : " (gone)"}` : "-"
  const views = f.views.length ? f.views.join(",") : "-"
  return [f.id, f.path, views, f.agent ?? "-", address].join("\t")
}

/** Close the windows and tabs that show the file */
async function closeInServer(
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
