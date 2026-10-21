// What the commands of every backend with open files share: opening a file in
// the server and showing its page, listing the open files, and closing one.

import { realpathSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { styleText } from "node:util"
import select from "@inquirer/select"
import { die, ensureStarted, serverJson } from "../../platform/cli.ts"
import { fileId } from "../id.ts"
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
import type { OpenRequest } from "./routes.ts"

/** The real path, or the absolute one for a file that may be gone */
export function absolute(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return resolvePath(file)
  }
}

/** Call the files API of the backend for `kind`; a non-2xx response exits with its body */
async function filesApi<T>(kind: FileKind, port: number, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}/view/${kind}/files`, init)
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return await serverJson<T>(res)
}

/** Open `path` bound to the agent this runs in, or from a shell in Rex, an
 * agent in its tab; the URL of its page, and where pages already show it */
export async function openInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<{ url: URL; views: Location[] }> {
  const address = currentAddress()
  await ensureStarted(port)
  const request: OpenRequest = address
    ? { path, address, agent: currentAgent(address) }
    : { path, address, agentId: await pickAgentNear(port) }
  const opened = await filesApi<FileInfo>(kind, port, {
    method: "POST",
    body: JSON.stringify(request),
  })
  return { url: new URL(opened.url, `http://127.0.0.1:${port}`), views: opened.views }
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
  const res = await fetch(
    `http://127.0.0.1:${port}/core/agents-near?block=${encodeURIComponent(block)}`,
  )
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  const agents = await serverJson<NearbyAgent[]>(res)
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
      die("ah: no agent picked, nothing opened")
    }
    throw e
  } finally {
    process.stdin.off("keypress", onKey)
  }
}

/** What the backend has open and which agent each file is bound to, for
 * opening them again after a restart; none with no server, or one from
 * before there was a handoff */
export async function handoff(kind: FileKind, port: number): Promise<OpenRequest[]> {
  if (!(await status(port))) return []
  const res = await fetch(`http://127.0.0.1:${port}/view/${kind}/files/handoff`)
  if (res.ok) return await serverJson<OpenRequest[]>(res)
  console.error(`ah: can't carry ${kind} files over: ${(await res.text()).trim()}`)
  return []
}

/** Open files again with their agents; a file that's gone stays closed.
 * Returns how many opened. */
export async function takeHandoff(
  kind: FileKind,
  port: number,
  requests: OpenRequest[],
): Promise<number> {
  let opened = 0
  for (const request of requests) {
    const res = await fetch(`http://127.0.0.1:${port}/view/${kind}/files`, {
      method: "POST",
      body: JSON.stringify(request),
    })
    if (res.ok) opened++
    else console.error(`ah: couldn't reopen ${request.path}: ${(await res.text()).trim()}`)
  }
  return opened
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

/** The open files of the backend for `kind`, oldest first; the server must be running */
export const openFiles = (kind: FileKind, port: number) => filesApi<FileInfo[]>(kind, port)

/** A file as `ah view ls` prints it: id, path, where its pages are, agent,
 * and where its comments go */
export function fileLine(f: FileInfo): string {
  const address = f.address ? `${f.address}${f.addressAlive ? "" : " (gone)"}` : "-"
  const views = f.views.length ? f.views.join(",") : "-"
  return [f.id, f.path, views, f.agent ?? "-", address].join("\t")
}

/** Close the file if the server has it open */
export async function closeInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<"closed" | "not open" | "no server"> {
  if (!(await status(port))) return "no server"
  const res = await fetch(`http://127.0.0.1:${port}/view/${kind}/files/${fileId(path)}`, {
    method: "DELETE",
  })
  if (res.status === 404) return "not open"
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return "closed"
}
