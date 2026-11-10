import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { bases, fileAt } from "./revisions.ts"

let dir: string
let notes: string

const jj = (...args: string[]) =>
  execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
    cwd: dir,
    stdio: "pipe",
  }).toString()

// notes.md: two commits, then a change in the working copy
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-revisions-")))
  notes = join(dir, "notes.md")
  jj("git", "init")
  writeFileSync(notes, "one\n")
  jj("commit", "-m", "Add notes")
  writeFileSync(notes, "one\ntwo\n")
  jj("commit", "-m", "Edit notes")
  writeFileSync(notes, "one\ntwo\nthree\n")
  // ah reads without snapshotting, as the user's own jj commands do it
  jj("status")
})
afterEach(() => rmSync(dir, { recursive: true }))

test("the file at a revision, by default the working copy's parent", async () => {
  expect(await fileAt(notes, "")).toMatchObject({
    rev: "@-",
    relation: "starting with",
    label: "the working copy",
    text: "one\ntwo\n",
  })
  expect(await fileAt(notes, "@--")).toMatchObject({
    relation: "starting with",
    label: "Edit notes",
    text: "one\n",
  })
  expect(await fileAt(notes, 'description(substring:"Edit")')).toMatchObject({
    relation: "since",
    label: "Edit notes",
  })
})

test("a file the revision doesn't have is empty there", async () => {
  const added = join(dir, "added.md")
  writeFileSync(added, "new\n")
  expect((await fileAt(added, "")).text).toBe("")
})

test("a revset that isn't one commit throws jj's complaint", async () => {
  await expect(fileAt(notes, "nonexistent")).rejects.toThrow(/nonexistent/)
  await expect(fileAt(notes, "::@-")).rejects.toThrow("::@- is more than one commit")
})

test("the bases are the revisions that changed the file, newest first, and trunk", async () => {
  const { history, trunk } = await bases(notes, "")
  expect(history.map((r) => [r.description, r.added, r.removed, r.workingCopy])).toEqual([
    ["", 1, 0, true],
    ["Edit notes", 1, 0, false],
    ["Add notes", 1, 0, false],
    // With no remote, trunk is the root commit
    ["", 0, 0, false],
  ])
  expect(trunk?.onTrunk).toBe(true)
})
