import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import {
  clearFile,
  clearSession,
  type Dirs,
  liveRecords,
  repoRoot,
  type ShownFile,
  writeRecord,
} from "./docs.ts"

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

function tempDirs(): Dirs {
  const base = mkdtempSync(join(tmpdir(), "ah-dashboard-"))
  const dirs = { state: join(base, "state"), claudeSessions: join(base, "claude") }
  mkdirSync(dirs.claudeSessions)
  return dirs
}

const startSession = (dirs: Dirs, pid: number) =>
  writeFileSync(join(dirs.claudeSessions, `${pid}.json`), "{}")
const endSession = (dirs: Dirs, pid: number) =>
  rmSync(join(dirs.claudeSessions, `${pid}.json`))

const record = (pid: number, file: string, since: string): ShownFile => ({
  harness: "claude",
  key: `claude-${pid}`,
  pid,
  sessionId: null,
  root: "/r/a",
  file,
  since,
})

test("records only count while their session runs", () => {
  const dirs = tempDirs()
  startSession(dirs, 1)
  startSession(dirs, 2)
  writeRecord(dirs, record(1, "/t/one.md", "2026-09-30T10:00:00Z"))
  writeRecord(dirs, record(2, "/t/two.md", "2026-09-30T11:00:00Z"))
  assertEquals(
    liveRecords(dirs).map((r) => r.pid),
    [2, 1],
  )

  endSession(dirs, 1)
  assertEquals(
    liveRecords(dirs).map((r) => r.pid),
    [2],
  )
  // The next write prunes the dead session's file
  writeRecord(dirs, record(2, "/t/three.md", "2026-09-30T12:00:00Z"))
  assertEquals(readdirSync(dirs.state), ["claude-2.json"])
  assertEquals(
    liveRecords(dirs).map((r) => r.file),
    ["/t/three.md"],
  )
})

test("clearing by session or by file", () => {
  const dirs = tempDirs()
  for (const pid of [1, 2, 3]) startSession(dirs, pid)
  writeRecord(dirs, record(1, "/t/shared.md", "2026-09-30T10:00:00Z"))
  writeRecord(dirs, record(2, "/t/shared.md", "2026-09-30T11:00:00Z"))
  writeRecord(dirs, record(3, "/t/other.md", "2026-09-30T12:00:00Z"))

  assertEquals(clearFile(dirs, "/t/shared.md"), 2)
  assertEquals(
    liveRecords(dirs).map((r) => r.pid),
    [3],
  )
  clearSession(dirs, "claude-3")
  clearSession(dirs, "claude-3")
  assertEquals(liveRecords(dirs), [])
})

test("a Codex record counts while its process runs", () => {
  const dirs = tempDirs()
  const codex = (pid: number, file: string): ShownFile => ({
    harness: "codex",
    key: `codex-${pid}`,
    pid,
    sessionId: "019a",
    root: "/r/a",
    file,
    since: "2026-09-30T10:00:00Z",
  })
  writeRecord(dirs, codex(process.pid, "/t/live.md"))
  // Past the macOS pid limit, so never running
  writeRecord(dirs, codex(99_999_999, "/t/dead.md"))
  assertEquals(
    liveRecords(dirs).map((r) => r.file),
    ["/t/live.md"],
  )
})

test("records from before they named their harness are skipped and pruned", () => {
  const dirs = tempDirs()
  startSession(dirs, 1)
  mkdirSync(dirs.state)
  writeFileSync(join(dirs.state, "1.json"), JSON.stringify({ pid: 1, file: "/t/old.md" }))
  assertEquals(liveRecords(dirs), [])
  writeRecord(dirs, record(1, "/t/new.md", "2026-09-30T10:00:00Z"))
  assertEquals(readdirSync(dirs.state), ["claude-1.json"])
})

test("a record missing a field is skipped", () => {
  const dirs = tempDirs()
  startSession(dirs, 1)
  startSession(dirs, 2)
  writeRecord(dirs, record(1, "/t/one.md", "2026-09-30T10:00:00Z"))
  const { since: _, ...noSince } = record(2, "/t/two.md", "")
  writeFileSync(join(dirs.state, "claude-2.json"), JSON.stringify(noSince))
  assertEquals(
    liveRecords(dirs).map((r) => r.pid),
    [1],
  )
})

test("liveRecords with no state dir yet", () => {
  assertEquals(liveRecords(tempDirs()), [])
})

test("repoRoot finds jj and git checkouts", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ah-dashboard-")))
  mkdirSync(join(base, "jj", ".jj"), { recursive: true })
  mkdirSync(join(base, "jj", "src", "deep"), { recursive: true })
  mkdirSync(join(base, "git", "src"), { recursive: true })
  // A secondary git worktree has a .git file, not a dir
  writeFileSync(join(base, "git", ".git"), "gitdir: elsewhere")
  assertEquals(repoRoot(join(base, "jj", "src", "deep")), join(base, "jj"))
  assertEquals(repoRoot(join(base, "git", "src")), join(base, "git"))
  assertEquals(repoRoot(base), null)
})
