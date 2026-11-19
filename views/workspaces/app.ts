// The jj workspaces a page may ask the server to open things in: the
// workspaces of the repo the page is in, and those listed in the
// workspaces.json next to the page. A request opens a diff in skepsis
// (views/skepsis/app.ts), or, here, a note in a window: a markdown or
// AsciiDoc note in the doc tool, through the page's _ah/doc, or an HTML note
// in the page tool, through _ah/page, as `ah tool doc` and `ah tool page`
// open them. A page's script can ask for any revision or note, but no page
// route writes workspaces.json, so a page opens windows only in the
// workspaces of its own repo and those its agent listed.

import { realpathSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { isRecord, isString } from "../../platform/guards.ts"
import { repoDir } from "../../platform/jj.ts"
import type { OpenFile, PageApp } from "../page/app.ts"

export const WORKSPACES_FILE = "workspaces.json"

/** Where a workspace's notes are, from its root */
const NOTES_DIR = ".claude/notes"

/** The workspaces the workspaces.json next to the page at `page` lists;
 * throws on one without `workspaces`, a list of strings */
async function listed(page: string): Promise<string[]> {
  const text = await readFile(join(dirname(page), WORKSPACES_FILE), "utf8").catch(
    () => null,
  )
  const file: unknown = text === null ? { workspaces: [] } : JSON.parse(text)
  if (
    !isRecord(file) ||
    !Array.isArray(file.workspaces) ||
    !file.workspaces.every(isString)
  )
    throw new Error(`${WORKSPACES_FILE} needs workspaces, a list of absolute paths`)
  return file.workspaces
}

/** The root of the workspace the page is in, or the page's directory if
 * it's in none. skepsis runs jj at the root, since jj's paths are relative
 * to where it runs. */
const ownRoot = (page: string) => rootFinder()(dirname(page)) ?? dirname(page)

/** The repo dir of the workspace whose root is `root`, or null if `root`
 * isn't a workspace's root */
function repoOf(root: string): string | null {
  try {
    return realpathSync(repoDir(root))
  } catch {
    return null
  }
}

/** Whether `a` and `b` are roots of workspaces of one repo */
function sameRepo(a: string, b: string): boolean {
  const repo = repoOf(a)
  return repo !== null && resolve(a) === a && repo === repoOf(b)
}

/** The response to a page's request to open something in `body.cwd`, or
 * with none, in the page's own workspace: `open`'s, or a 403 for a
 * workspace that isn't one of the page's repo or in its workspaces.json */
export async function inWorkspace(
  page: string,
  body: unknown,
  open: (cwd: string) => Promise<Response>,
): Promise<Response> {
  const own = ownRoot(page)
  const cwd = isRecord(body) && body.cwd !== undefined ? body.cwd : own
  try {
    if (!isString(cwd) || !(sameRepo(cwd, own) || (await listed(page)).includes(cwd)))
      return new Response(
        `${String(cwd)} isn't a workspace of this page's repo or in its ${WORKSPACES_FILE}`,
        { status: 403 },
      )
    return await open(cwd)
  } catch (e) {
    return new Response((e as Error).message, { status: 500 })
  }
}

/** The names of the notes each route opens */
const NOTES: Record<string, RegExp> = {
  "_ah/doc": /\.(md|a(scii)?doc)$/i,
  "_ah/page": /\.html?$/i,
}

/** The real path of the note `file`, a path from `cwd`'s notes directory;
 * null if it isn't a file in there with a name like `named`. Real paths are
 * compared, since a secondary workspace's notes directory is usually a link
 * to the default workspace's. */
async function notePath(cwd: string, file: unknown, named: RegExp): Promise<string | null> {
  if (!isString(file) || !named.test(file)) return null
  const dir = await realpath(join(cwd, NOTES_DIR)).catch(() => null)
  const path = dir && (await realpath(resolve(dir, file)).catch(() => null))
  return path?.startsWith(dir + "/") ? path : null
}

/** `openFile` opens the note a page's request names, bound to the page's
 * agent */
export function noteApp(openFile: OpenFile): PageApp {
  return {
    async routes(sub, req, path, agent) {
      const named = NOTES[sub]
      if (!named || req.method !== "POST") return null
      const body: unknown = await req.json().catch(() => null)
      return await inWorkspace(path, body, async (cwd) => {
        const note = await notePath(cwd, isRecord(body) ? body.file : null, named)
        if (!note) return new Response(`no such note in ${cwd}`, { status: 404 })
        await openFile(note, agent)
        return new Response(null, { status: 204 })
      })
    },
  }
}
