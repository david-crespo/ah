// What the commands of every backend with open files share: opening a file in
// the server and showing its page, listing the open files, and closing one.

import { realpathSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { die, ensureStarted, serverJson } from "../../platform/cli.ts"
import { fileId } from "../id.ts"
import { run } from "../../platform/proc.ts"
import { currentAgent, currentAddress } from "../../platform/session.ts"
import { status } from "../../platform/server.ts"
import type { FileKind } from "../../core/model.ts"
import type { FileInfo } from "./files.ts"
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

/** Open `path` bound to the agent this runs in; the URL of its page */
export async function openInServer(
  kind: FileKind,
  port: number,
  path: string,
): Promise<URL> {
  const address = currentAddress()
  const request: OpenRequest = { path, address, agent: currentAgent(address) }
  if (!address) {
    console.error("ah: not in an agent session; comments won't go anywhere")
  }
  await ensureStarted(port)
  const opened = await filesApi<FileInfo>(kind, port, {
    method: "POST",
    body: JSON.stringify(request),
  })
  return new URL(opened.url, `http://127.0.0.1:${port}`)
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

/** In a Chrome app window or a tab of the default browser */
export async function showPage(place: "window" | "tab", url: URL) {
  // Its socket says so, for `ah view ls`
  url.searchParams.set("in", place)
  if (place === "window") {
    // -n hands the window to the running Chrome, which creates it without
    // coming forward. Activating Chrome brings the new window in front of
    // the terminal.
    await run("open", ["-na", "Google Chrome", "--args", `--app=${url}`])
    await run("open", ["-a", "Google Chrome"])
  } else {
    await run("open", [url.href])
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
