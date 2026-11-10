// A home page as a page app (views/page/app.ts): what it draws (data.ts) at
// _ah/home, and a watch on the directory of its workstreams.md, so the page
// reads its data again when that or home.json is saved. Agents start and
// stop without any file changing, so the page also asks again now and then
// while it's in view; nothing here runs while no page is open.

import { basename, dirname } from "node:path"
import type { AgentView } from "../../core/agent_view.ts"
import type { PageApp } from "../page/app.ts"
import { noStore } from "../page/routes.ts"
import {
  HOME_FILE,
  parseHomeFile,
  readHome,
  readHomeFile,
  workstreamsPath,
  type HomeFile,
} from "./data.ts"

/** `agents` lists the live agents */
export function homeApp(agents: () => AgentView[]): PageApp {
  return {
    async routes(sub, _req, path, agent) {
      if (sub !== "_ah/home") return null
      const home = await readHome(path, agents(), agent)
      return home && Response.json(home, { headers: noStore })
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
