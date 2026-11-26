import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { doctorNotice, type FileUpgrade, Upgrades } from "./upgrades.ts"

const rename: FileUpgrade = {
  what: "old to new",
  needs: (text) => text.includes("old"),
  how: "change old to new",
}
const odd: FileUpgrade = {
  what: "odd",
  needs: (text) => text.includes("odd"),
  how: "fix it",
}

let dir: string
let [a, b] = ["", ""]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-upgrades-"))
  for (const ws of ["a", "b"]) mkdirSync(join(dir, ws))
  ;[a, b] = [join(dir, "a", "page.html"), join(dir, "b", "page.html")]
})

test("finds the files that need upgrades", () => {
  writeFileSync(a, "old odd")
  writeFileSync(b, "fine")
  const upgrades = new Upgrades([rename, odd])
  upgrades.scan([a, b, join(dir, "gone.html")])
  expect(upgrades.outdated()).toEqual([
    { path: a, what: "old to new", how: "change old to new" },
    { path: a, what: "odd", how: "fix it" },
  ])
})

test("checks the files again, since an agent may have fixed them", () => {
  writeFileSync(a, "old")
  writeFileSync(b, "old")
  const upgrades = new Upgrades([rename])
  upgrades.scan([a, b])
  writeFileSync(a, "new")
  rmSync(b)
  expect(upgrades.outdated()).toEqual([])
})

test("the notice counts files, not upgrades", () => {
  expect(doctorNotice([])).toEqual(null)
  const twice = [
    { path: a, what: "x", how: "" },
    { path: a, what: "y", how: "" },
  ]
  expect(doctorNotice(twice)).toMatch(
    /^ah: `ah doctor` finds 1 file in this workspace that uses an old ah format\. Run it/,
  )
})
