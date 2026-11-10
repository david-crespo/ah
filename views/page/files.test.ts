import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test, vi } from "vitest"
import type { Pages } from "../../subjects/files/files.ts"
import type { PageApp } from "./app.ts"
import { LiveReload } from "./files.ts"

/** An app whose pages' data is data.json next to them and anything in `dirs` */
const app = (dirs: string[]): PageApp => ({
  routes: async () => null,
  watch: async () => ({ dirs, data: (filename) => filename === "data.json" }),
})

test("an app's page is told its data changed, and to reload for anything else", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-live-")))
  const other = join(root, "other")
  const dir = join(root, "notes")
  mkdirSync(other)
  mkdirSync(dir)
  const sent: string[] = []
  const pages = {
    broadcast: (m: string) => sent.push(JSON.parse(m).type),
  } as unknown as Pages
  const live = new LiveReload(join(dir, "index.html"), pages, [app([other])])
  /** What the pages are sent after `change` */
  const after = async (change: () => void) => {
    sent.length = 0
    change()
    await expect.poll(() => sent).toHaveLength(1)
    return sent[0]
  }
  try {
    // Until the app's watch is up, every change is a reload
    await sleep(200)
    expect(await after(() => writeFileSync(join(dir, "data.json"), "{}"))).toBe("data")
    expect(await after(() => writeFileSync(join(other, "abc"), ""))).toBe("data")
    expect(await after(() => writeFileSync(join(dir, "index.html"), ""))).toBe("reload")
    // Together, the reload wins
    const both = after(() => {
      writeFileSync(join(dir, "data.json"), "{ }")
      writeFileSync(join(dir, "page.css"), "")
    })
    expect(await both).toBe("reload")
  } finally {
    live.close()
    rmSync(root, { recursive: true })
  }
})

test("an app's watch that can't start logs instead of rejecting", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-live-")))
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const live = new LiveReload(join(root, "index.html"), {} as Pages, [
    app([join(root, "gone")]),
  ])
  try {
    await expect.poll(() => error.mock.calls.length).toBe(1)
  } finally {
    live.close()
    error.mockRestore()
    rmSync(root, { recursive: true })
  }
})
