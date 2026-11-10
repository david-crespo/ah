import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { AgentView } from "../../core/agent_view.ts"
import {
  type HomeFile,
  joinAgents,
  parseHomeFile,
  parseWorkstreams,
  projectStatus,
  readHome,
} from "./data.ts"

const SAMPLE = `# Workstreams

Intro text that isn't any project's.

## Work

**Docs versioning.** Versioned docs,
hard-wrapped here.

A second paragraph
of it.

**ah (doc editor, stack).** The agent host.

## Own tools

Under a heading, before any project.

**Concierge.**
Holds it all in view.
`

test("workstreams are grouped by heading, a project per bold paragraph, lines unwrapped", () => {
  expect(parseWorkstreams(SAMPLE)).toEqual([
    {
      group: "Work",
      name: "Docs versioning",
      paragraphs: ["Versioned docs, hard-wrapped here.", "A second paragraph of it."],
    },
    { group: "Work", name: "ah (doc editor, stack)", paragraphs: ["The agent host."] },
    { group: "Own tools", name: "Concierge", paragraphs: ["Holds it all in view."] },
  ])
})

const agent = (over: Partial<AgentView>): AgentView => ({
  id: "a",
  harness: "claude",
  session: "s",
  label: "",
  cwd: "/r",
  busy: false,
  summary: null,
  shown: false,
  ended: false,
  block: null,
  tab: null,
  process: { pid: 1, status: "idle", socket: null } as AgentView["process"],
  ...over,
})

const file: HomeFile = {
  title: "Home",
  projects: [
    { name: "ah", repos: ["/repos/ah"], prs: [], workers: [] },
    {
      name: "Docs",
      repos: ["/repos", "/repos/docs/"],
      prs: [],
      workers: [{ session: "s-worker", asked: "Fix the picker" }],
    },
  ],
  waiting: [],
  finished: [],
}

test("an agent is its worker entry's project, else its longest repo's", () => {
  const rows = joinAgents(
    file,
    [
      agent({ id: "w", session: "s-worker", cwd: "/repos/ah" }),
      agent({ id: "d", cwd: "/repos/docs/src", busy: true }),
      agent({ id: "x", cwd: "/repos/ahx" }),
      agent({ id: "o", cwd: "/elsewhere" }),
      agent({ id: "me", cwd: "/repos/ah" }),
      agent({ id: "gone", process: null }),
      agent({ id: "ended", ended: true }),
    ],
    "me",
  )
  expect(rows.map((r) => [r.id, r.project, r.asked, r.self])).toEqual([
    ["d", "Docs", null, undefined],
    ["w", "Docs", "Fix the picker", undefined],
    // /repos/ahx isn't under /repos/ah, but it is under /repos
    ["x", "Docs", null, undefined],
    ["o", null, null, undefined],
    ["me", "ah", null, true],
  ])
})

test("a project needs you while something waits on it, else runs while an agent of it is busy", () => {
  const rows = joinAgents(file, [agent({ cwd: "/repos/ah", busy: true })])
  const waiting = [
    { id: "1", project: "Docs", text: "", written: "", links: [] },
  ] satisfies HomeFile["waiting"]
  expect(projectStatus("Docs", waiting, rows)).toBe("needs you")
  expect(projectStatus("ah (doc editor, stack)", waiting, rows)).toBe("running")
  expect(projectStatus("Concierge", waiting, rows)).toBe("idle")
})

test("home.json is read leniently: entries missing what they need are left out", () => {
  const parsed = parseHomeFile(
    JSON.stringify({
      title: 3,
      projects: [
        { name: "ah", repos: ["/a", 4], workers: [{ asked: "x" }] },
        { repos: [] },
      ],
      waiting: [
        {
          id: "1",
          project: "ah",
          text: "Look",
          written: "2026-11-10T09:00:00Z",
          links: [{ label: "l" }],
        },
        { id: "2", text: "no project" },
      ],
      finished: "nope",
    }),
  )
  expect(parsed).toEqual({
    title: "",
    workstreams: undefined,
    projects: [{ name: "ah", repos: ["/a"], prs: [], workers: [] }],
    waiting: [
      {
        id: "1",
        project: "ah",
        text: "Look",
        written: "2026-11-10T09:00:00Z",
        note: undefined,
        link: undefined,
        links: [],
      },
    ],
    finished: [],
  })
  expect(() => parseHomeFile("[]")).toThrow("isn't a JSON object")
})

test("a page's home is null without home.json, and a bad file is an error, not a failure", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-home-")))
  const page = join(dir, "home", "index.html")
  try {
    expect(await readHome(join(dir, "index.html"), [], null)).toBeNull()
    mkdirSync(join(dir, "home"))
    writeFileSync(join(dir, "home", "home.json"), "{ not json")
    const bad = await readHome(page, [], null)
    expect(bad?.errors).toHaveLength(2)
    expect(bad?.errors[0]).toMatch(/^home\.json: /)
    expect(bad?.projects).toEqual([])

    writeFileSync(join(dir, "home", "home.json"), JSON.stringify(file))
    writeFileSync(join(dir, "workstreams.md"), SAMPLE)
    const good = await readHome(page, [agent({ cwd: "/repos/ah", busy: true })], null)
    expect(good?.errors).toEqual([])
    expect(good?.projects.map((p) => [p.name, p.status])).toEqual([
      ["Docs versioning", "idle"],
      ["ah (doc editor, stack)", "running"],
      ["Concierge", "idle"],
    ])
  } finally {
    rmSync(dir, { recursive: true })
  }
})
