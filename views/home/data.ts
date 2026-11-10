// A home page's data, which client.ts draws: the home.json next to the page,
// which the agent that keeps the page (a concierge) writes; the prose file of
// projects it points to (workstreams.md), by `## Group` heading and
// `**Name.**` paragraph; and the live agents, each joined to a project. What
// can be looked up is never written: a project's status and the agents are
// computed on every read.

import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { AgentId } from "../../model.ts"
import { type AgentView, isCurrent } from "../../core/agent_view.ts"
import { isRecord, isString } from "../../platform/guards.ts"

export const HOME_FILE = "home.json"
const WORKSTREAMS = "../workstreams.md"

export interface Worker {
  /** An ah agent id or a harness session id */
  agent?: string
  session?: string
  /** What it was asked to do, in a line */
  asked: string
}

export interface Project {
  /** As in workstreams.md, without the trailing period */
  name: string
  /** Absolute paths. An agent whose cwd is one of these or under it is the project's */
  repos: string[]
  /** "owner/repo#n" */
  prs: string[]
  /** Workers the agent keeping the page started */
  workers: Worker[]
}

export interface Waiting {
  id: string
  project: string
  text: string
  /** ISO time it was written */
  written: string
  note?: string
  link?: string
  links: { label: string; href: string }[]
}

export interface Finished {
  project: string
  text: string
  /** ISO time */
  at: string
}

export interface HomeFile {
  title: string
  /** The prose file of projects, relative to home.json */
  workstreams?: string
  projects: Project[]
  waiting: Waiting[]
  finished: Finished[]
}

/** A project in workstreams.md: its `##` group and its paragraphs, unwrapped */
export interface Workstream {
  group: string
  name: string
  paragraphs: string[]
}

export type Status = "needs you" | "running" | "idle"

/** A live agent, with the project it's working on, if any */
export interface AgentRow {
  id: AgentId
  harness: string
  label: string
  cwd: string
  busy: boolean
  summary: string | null
  project: string | null
  /** What it was asked, from its worker entry */
  asked: string | null
  /** The agent the page is bound to */
  self?: true
}

export interface Home {
  file: HomeFile
  projects: (Workstream & { status: Status })[]
  agents: AgentRow[]
  /** The server's time when it read these, ISO */
  readAt: string
  /** Files that couldn't be read. The rest is still there. */
  errors: string[]
}

const records = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : [])
const strings = (v: unknown) => (Array.isArray(v) ? v.filter(isString) : [])
const optional = (v: unknown) => (isString(v) ? v : undefined)

/** home.json, leniently: an entry without what it needs is left out, and a
 * field of the wrong type is as if missing. Throws only on text that isn't
 * a JSON object. */
export function parseHomeFile(text: string): HomeFile {
  const file: unknown = JSON.parse(text)
  if (!isRecord(file)) throw new Error(`${HOME_FILE} isn't a JSON object`)
  return {
    title: optional(file.title) ?? "",
    workstreams: optional(file.workstreams),
    projects: records(file.projects)
      .filter((p) => isString(p.name))
      .map((p) => ({
        name: p.name as string,
        repos: strings(p.repos),
        prs: strings(p.prs),
        workers: records(p.workers)
          .filter((w) => isString(w.asked) && (isString(w.agent) || isString(w.session)))
          .map((w) => ({
            agent: optional(w.agent),
            session: optional(w.session),
            asked: w.asked as string,
          })),
      })),
    waiting: records(file.waiting)
      .filter((w) => isString(w.id) && isString(w.project) && isString(w.text))
      .map((w) => ({
        id: w.id as string,
        project: w.project as string,
        text: w.text as string,
        written: optional(w.written) ?? "",
        note: optional(w.note),
        link: optional(w.link),
        links: records(w.links)
          .filter((l) => isString(l.label) && isString(l.href))
          .map((l) => ({ label: l.label as string, href: l.href as string })),
      })),
    finished: records(file.finished)
      .filter((f) => isString(f.project) && isString(f.text))
      .map((f) => ({
        project: f.project as string,
        text: f.text as string,
        at: optional(f.at) ?? "",
      })),
  }
}

/** The projects in workstreams.md. A project starts at a paragraph that
 * begins `**Name.**` and runs to the next one or the next heading. Text
 * before the first `##`, or between a heading and its first project, isn't
 * any project's. */
export function parseWorkstreams(markdown: string): Workstream[] {
  const projects: Workstream[] = []
  let group: string | null = null
  let project: Workstream | null = null
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim().replace(/\s*\n\s*/g, " ")
    const heading = text.match(/^##\s+(.+)/)
    if (heading) {
      group = heading[1].trim()
      project = null
      continue
    }
    if (text.startsWith("#")) {
      project = null
      continue
    }
    const start = group !== null && text.match(/^\*\*(.+?)\.\*\*\s*(.*)$/)
    if (start) {
      project = { group: group!, name: start[1], paragraphs: [] }
      projects.push(project)
      if (start[2]) project.paragraphs.push(start[2])
    } else if (project && text) project.paragraphs.push(text)
  }
  return projects
}

/** A project's name without a note in parentheses after it, so "ah (doc
 * editor, trackers)" in workstreams.md is the "ah" of home.json */
export const projectKey = (name: string) => name.replace(/\s*\(.*\)$/, "")
const sameProject = (a: string, b: string) => projectKey(a) === projectKey(b)

/** Each live agent, busy ones first, with its project: the one that lists
 * it as a worker, else the one with the longest repo its cwd is in */
export function joinAgents(
  file: HomeFile,
  agents: AgentView[],
  self: AgentId | null = null,
): AgentRow[] {
  const live = agents.filter((a) => isCurrent(a) && !a.ended)
  const rows = live.map((a): AgentRow => {
    let project: string | null = null
    let asked: string | null = null
    for (const p of file.projects) {
      const worker = p.workers.find((w) => w.agent === a.id || w.session === a.session)
      if (worker) {
        project = p.name
        asked = worker.asked
        break
      }
    }
    const cwd = a.cwd ?? ""
    if (!project && cwd) {
      let longest = -1
      for (const p of file.projects)
        for (const repo of p.repos) {
          const r = repo.replace(/\/+$/, "")
          const within = cwd === r || cwd.startsWith(r + "/")
          if (within && r.length > longest) {
            longest = r.length
            project = p.name
          }
        }
    }
    const { id, harness, label, busy, summary } = a
    const row: AgentRow = { id, harness, label, cwd, busy, summary, project, asked }
    if (id === self) row.self = true
    return row
  })
  return rows.sort((a, b) => Number(b.busy) - Number(a.busy))
}

/** Needs you while a waiting item is the project's, else running while one
 * of its agents is busy */
export function projectStatus(name: string, waiting: Waiting[], rows: AgentRow[]): Status {
  if (waiting.some((w) => sameProject(w.project, name))) return "needs you"
  if (rows.some((r) => r.busy && r.project !== null && sameProject(r.project, name)))
    return "running"
  return "idle"
}

/** Where home.json says workstreams.md is */
export const workstreamsPath = (pagePath: string, file: HomeFile) =>
  resolve(dirname(pagePath), file.workstreams ?? WORKSTREAMS)

/** The home.json next to `pagePath`, or null if there isn't one */
export async function readHomeFile(pagePath: string): Promise<string | null> {
  return await readFile(join(dirname(pagePath), HOME_FILE), "utf8").catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null
      throw e
    },
  )
}

/** Everything the page draws, or null if there's no home.json next to
 * `pagePath`. A file that can't be read is an error in the result, with an
 * empty file or project list in its place. */
export async function readHome(
  pagePath: string,
  agents: AgentView[],
  self: AgentId | null,
): Promise<Home | null> {
  const errors: string[] = []
  let file: HomeFile = { title: "", projects: [], waiting: [], finished: [] }
  try {
    const text = await readHomeFile(pagePath)
    if (text === null) return null
    file = parseHomeFile(text)
  } catch (e) {
    errors.push(`${HOME_FILE}: ${(e as Error).message}`)
  }
  const path = workstreamsPath(pagePath, file)
  const workstreams = await readFile(path, "utf8").then(parseWorkstreams, (e: Error) => {
    errors.push(e.message)
    return []
  })
  const rows = joinAgents(file, agents, self)
  return {
    file,
    projects: workstreams.map((p) => ({
      ...p,
      status: projectStatus(p.name, file.waiting, rows),
    })),
    agents: rows,
    readAt: new Date().toISOString(),
    errors,
  }
}
