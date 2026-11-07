import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { ahStateDir } from "./paths.ts"
import { MIGRATIONS, moveInto, STATE_VERSION, upgradeState } from "./state_version.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-state-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  process.env.XDG_CACHE_HOME = join(dir, "cache")
})

const version = () => readFileSync(ahStateDir("version"), "utf8").trim()

test("a fresh install starts at the latest version and runs nothing", () => {
  expect(upgradeState()).toEqual([])
  expect(version()).toEqual(String(STATE_VERSION))
})

test("state from before versioning runs every migration, once", () => {
  mkdirSync(ahStateDir("markdown"), { recursive: true })
  writeFileSync(ahStateDir("markdown", "a.jsonl"), "a")
  mkdirSync(join(dir, "cache", "ah", "markdown"), { recursive: true })
  expect(upgradeState()).toEqual(
    MIGRATIONS.map((m) => `ah: migrated state to version ${m.to}: ${m.what}`),
  )
  expect(readFileSync(ahStateDir("doc", "a.jsonl"), "utf8")).toEqual("a")
  expect(existsSync(ahStateDir("markdown"))).toEqual(false)
  expect(existsSync(join(dir, "cache", "ah", "markdown"))).toEqual(false)
  expect(version()).toEqual(String(STATE_VERSION))
  expect(upgradeState()).toEqual([])
})

test("runs only the migrations past the recorded version", () => {
  const ran: number[] = []
  const migrations = [1, 2, 3].map((to) => ({
    to,
    what: `v${to}`,
    run: () => ran.push(to),
  }))
  mkdirSync(ahStateDir(), { recursive: true })
  writeFileSync(ahStateDir("version"), "1\n")
  expect(upgradeState(migrations)).toEqual([
    "ah: migrated state to version 2: v2",
    "ah: migrated state to version 3: v3",
  ])
  expect(ran).toEqual([2, 3])
  expect(version()).toEqual("3")
})

test("refuses state newer than the code", () => {
  mkdirSync(ahStateDir(), { recursive: true })
  writeFileSync(ahStateDir("version"), "99\n")
  expect(() => upgradeState()).toThrow(/version 99, newer than this ah's/)
})

test("moving into a directory that has the same file keeps the newer one", () => {
  const [from, to] = [join(dir, "from"), join(dir, "to")]
  mkdirSync(from)
  mkdirSync(to)
  for (const [d, name, text, at] of [
    [from, "old", "from", 1],
    [to, "old", "to", 2],
    [from, "new", "from", 2],
    [to, "new", "to", 1],
  ] as const) {
    writeFileSync(join(d, name), text)
    utimesSync(join(d, name), at, at)
  }
  moveInto(from, to)
  expect(readFileSync(join(to, "old"), "utf8")).toEqual("to")
  expect(readFileSync(join(to, "new"), "utf8")).toEqual("from")
  expect(existsSync(from)).toEqual(false)
})

test("moving merges directories both have, so files only one has stay", () => {
  const [from, to] = [join(dir, "from", "blobs"), join(dir, "to", "blobs")]
  mkdirSync(join(from, "o", "r", "old-sha"), { recursive: true })
  mkdirSync(join(to, "o", "r", "new-sha"), { recursive: true })
  writeFileSync(join(from, "o", "r", "old-sha", "a.ts"), "a")
  writeFileSync(join(to, "o", "r", "new-sha", "b.ts"), "b")
  utimesSync(from, 1, 1)
  utimesSync(to, 2, 2)
  moveInto(join(dir, "from"), join(dir, "to"))
  expect(readFileSync(join(to, "o", "r", "old-sha", "a.ts"), "utf8")).toEqual("a")
  expect(readFileSync(join(to, "o", "r", "new-sha", "b.ts"), "utf8")).toEqual("b")
  expect(existsSync(join(dir, "from"))).toEqual(false)
})
