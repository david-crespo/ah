import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "vitest"
import type { Pages } from "../../subjects/files/files.ts"
import { LiveReload } from "../page/files.ts"
import { HOME_FILE } from "./data.ts"
import { homeApp } from "./routes.ts"

const app = homeApp(() => [])
const get = new Request("http://127.0.0.1/")

test("a home page is told its data changed, and to reload for anything else", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-home-")))
  const dir = join(root, "home")
  mkdirSync(dir)
  writeFileSync(join(dir, HOME_FILE), "{}")
  const sent: string[] = []
  const pages = {
    broadcast: (m: string) => sent.push(JSON.parse(m).type),
  } as unknown as Pages
  const live = new LiveReload(join(dir, "index.html"), pages, [app])
  const after = async (change: () => void) => {
    sent.length = 0
    change()
    await expect.poll(() => sent).toHaveLength(1)
    return sent[0]
  }
  try {
    // Until the app's watch is up, every change is a reload
    await sleep(200)
    expect(await after(() => writeFileSync(join(dir, HOME_FILE), "{ }"))).toBe("data")
    expect(await after(() => writeFileSync(join(root, "workstreams.md"), "#"))).toBe("data")
    expect(await after(() => writeFileSync(join(dir, "index.html"), ""))).toBe("reload")
  } finally {
    live.close()
    rmSync(root, { recursive: true })
  }
})

test("only a page with home.json next to it is the app's, and a bad one is still drawn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-home-")))
  const page = join(root, "index.html")
  try {
    expect(await app.routes("_ah/home", get, page, null)).toBeNull()
    expect(await app.watch!(page)).toBeNull()
    writeFileSync(join(root, HOME_FILE), "not json")
    const res = await app.routes("_ah/home", get, page, null)
    expect(res?.status).toBe(200)
    expect((await res!.json()).errors).toHaveLength(2)
    expect(await app.routes("_ah/other", get, page, null)).toBeNull()
  } finally {
    rmSync(root, { recursive: true })
  }
})
