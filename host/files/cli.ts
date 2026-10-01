// What the commands of every app with open files share: opening a file in
// the server and showing its page, listing the open files, and closing one.

import { realpathSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { die, ensureStarted, serverJson } from "../cli.ts"
import { fileId } from "../id.ts"
import { run } from "../proc.ts"
import { currentSession } from "../session.ts"
import { status } from "../server.ts"
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

/** Call an app's files API; a non-2xx response exits with its body */
async function filesApi<T>(app: string, port: number, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}/app/${app}/files`, init)
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return await serverJson<T>(res)
}

/** Open `path` bound to the session this runs in; the URL of its page */
export async function openInServer(app: string, port: number, path: string): Promise<URL> {
  const request: OpenRequest = { path, session: currentSession() }
  if (!request.session) {
    console.error("ah: not in an agent session; comments won't go anywhere")
  }
  await ensureStarted(port)
  const opened = await filesApi<FileInfo>(app, port, {
    method: "POST",
    body: JSON.stringify(request),
  })
  return new URL(opened.url, `http://127.0.0.1:${port}`)
}

/** In a Chrome app window or a tab of the default browser */
export async function showPage(place: "window" | "tab", url: URL) {
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

/** Print the app's open files, oldest first */
export async function printOpenFiles(app: string, port: number) {
  if (!(await status(port))) return console.error("ah: server not running, no files open")
  for (const f of await filesApi<FileInfo[]>(app, port)) {
    const session = f.session ? `${f.session}${f.sessionAlive ? "" : " (gone)"}` : "-"
    console.log([f.id, f.path, session].join("\t"))
  }
}

/** Close the file if the server has it open */
export async function closeInServer(
  app: string,
  port: number,
  path: string,
): Promise<"closed" | "not open" | "no server"> {
  if (!(await status(port))) return "no server"
  const res = await fetch(`http://127.0.0.1:${port}/app/${app}/files/${fileId(path)}`, {
    method: "DELETE",
  })
  if (res.status === 404) return "not open"
  if (!res.ok) die(`ah: ${(await res.text()).trim()}`)
  return "closed"
}
