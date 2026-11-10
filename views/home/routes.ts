// A home page as a page app (views/page/app.ts): what it draws (data.ts) at
// _ah/home; its Stack buttons and file links at _ah/open, which open a file
// home.json lists in a window, and nothing else; and a watch on the directory of its workstreams.md, so the page
// reads its data again when that or home.json is saved. Agents start and
// stop without any file changing, so the page also asks again now and then
// while it's in view; nothing here runs while no page is open.

import { stat } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { AgentView } from "../../core/agent_view.ts"
import type { OpenFile, PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import {
  HOME_FILE,
  listedFile,
  parseHomeFile,
  readHome,
  readHomeFile,
  workstreamsPath,
  type HomeFile,
} from "./data.ts"

const notListed = () => new Response("home.json doesn't list that file", { status: 404 })

/** `agents` lists the live agents, and `open` opens a file home.json lists */
export function homeApp(agents: () => AgentView[], open: OpenFile): PageApp {
  return {
    async routes(sub, req, path, agent) {
      if (sub === "_ah/home") {
        const home = await readHome(path, agents(), agent)
        return home && Response.json(home, { headers: noStore })
      }
      if (sub === "_ah/open" && req.method === "POST") {
        const text = await readHomeFile(path).catch(() => null)
        if (text === null) return null
        let file: HomeFile
        try {
          file = parseHomeFile(text)
        } catch {
          return notListed()
        }
        const target = listedFile(path, file, await req.json().catch(() => null))
        if (!target) return notListed()
        if (!(await stat(target).catch(() => null)))
          return new Response(`no file at ${target}`, { status: 404 })
        return await open(target, agent).then(
          () => new Response(null, { status: 204 }),
          (e: Error) => new Response(e.message, { status: 500 }),
        )
      }
      return null
    },
    async watch(path) {
      const text = await readHomeFile(path).catch(() => "")
      if (text === null) return null
      let file: HomeFile = { title: "", projects: [], waiting: [], finished: [] }
      try {
        file = parseHomeFile(text)
      } catch {
        /* the page says so; the default's dir is still watched */
      }
      const workstreams = workstreamsPath(path, file)
      const dir = dirname(workstreams)
      // In the page's own directory, it's a file there that's data
      return {
        dirs: dir === dirname(path) ? [] : [dir],
        data: (name) => name === HOME_FILE || name === basename(workstreams),
      }
    },
  }
}
