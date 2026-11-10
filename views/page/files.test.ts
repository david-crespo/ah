import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test, vi } from "vitest"
import type { Pages } from "../../subjects/files/files.ts"
import { LiveReload } from "./files.ts"
import { STACK_FILE } from "../stack/data.ts"

test("a stack's page is told its data changed, and to reload for anything else", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-live-")))
  const ops = join(root, ".jj", "repo", "op_heads", "heads")
  const dir = join(root, "notes")
  mkdirSync(ops, { recursive: true })
  mkdirSync(dir)
  writeFileSync(join(dir, STACK_FILE), "{}")
  const sent: string[] = []
  const pages = {
    broadcast: (m: string) => sent.push(JSON.parse(m).type),
  } as unknown as Pages
  const live = new LiveReload(join(dir, "index.html"), pages)
  /** What the pages are sent after `change` */
  const after = async (change: () => void) => {
    sent.length = 0
    change()
    await expect.poll(() => sent).toHaveLength(1)
    return sent[0]
  }
  try {
    // Until the repo's watch is up, every change is a reload
    await sleep(200)
    expect(await after(() => writeFileSync(join(dir, "one.md"), "# One\n"))).toBe("data")
    expect(await after(() => writeFileSync(join(dir, STACK_FILE), "{ }"))).toBe("data")
    expect(await after(() => writeFileSync(join(ops, "abc"), ""))).toBe("data")
    expect(await after(() => writeFileSync(join(dir, "index.html"), ""))).toBe("reload")
    // Together, the reload wins
    const both = after(() => {
      writeFileSync(join(dir, "one.md"), "# 1\n")
      writeFileSync(join(dir, "page.css"), "")
    })
    expect(await both).toBe("reload")
  } finally {
    live.close()
    rmSync(root, { recursive: true })
  }
})

test("a stack in a workspace whose repo is gone logs instead of rejecting", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-live-")))
  mkdirSync(join(root, ".jj"))
  writeFileSync(join(root, ".jj", "repo"), "../gone/.jj/repo")
  writeFileSync(join(root, STACK_FILE), "{}")
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const live = new LiveReload(join(root, "index.html"), {} as Pages)
  try {
    await expect.poll(() => error.mock.calls.length).toBe(1)
  } finally {
    live.close()
    error.mockRestore()
    rmSync(root, { recursive: true })
  }
})
