// What an app built on pages gives the page host (routes.ts, files.ts), like
// a stack's page (views/stack/): routes under a page's _ah/, tried before the
// generic ones, and what tells one of its pages that its data changed. Such
// a page draws its data itself, so it's told that rather than reloaded.

import type { AgentId } from "../../model.ts"

/** What a page's live reload watches for an app: `dirs`, where any change
 * is to the page's data, and the files in the page's own directory that
 * are its data, by name */
export interface AppWatch {
  dirs: string[]
  data(filename: string): boolean
}

/** Open a file in its tool's page, a markdown file's doc page or an HTML
 * file's page, in a window, bound to `agent` */
export type OpenFile = (path: string, agent: AgentId | null) => Promise<void>

export interface PageApp {
  /** The response for `sub`, the path after the page's, of the page at
   * `path`, bound to `agent`; null for a path that isn't the app's */
  routes(
    sub: string,
    req: Request,
    path: string,
    agent: AgentId | null,
  ): Promise<Response | null>
  /** Null for a page that isn't the app's */
  watch?(path: string): Promise<AppWatch | null>
}
