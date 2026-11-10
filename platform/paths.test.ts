import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { rotateLog } from "./paths.ts"

test("rotateLog moves a log past its size to .old, over the last one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-paths-"))
  const log = join(dir, "x.log")
  try {
    rotateLog(log, 4)
    writeFileSync(log, "four")
    rotateLog(log, 4)
    expect(readFileSync(log, "utf8")).toBe("four")
    writeFileSync(`${log}.old`, "before")
    writeFileSync(log, "fives")
    rotateLog(log, 4)
    expect(existsSync(log)).toBe(false)
    expect(readFileSync(`${log}.old`, "utf8")).toBe("fives")
  } finally {
    rmSync(dir, { recursive: true })
  }
})
