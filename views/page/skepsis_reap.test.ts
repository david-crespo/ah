import { execFileSync } from "node:child_process"
import { expect, test, vi } from "vitest"

// A skepsis that says where it's listening and stays, and no real windows
const shown = new Set<string>()
vi.hoisted(() => {
  // No spaces, since AH_SKEPSIS is split on them
  const script = String.raw`console.log("skepsis\x20on\x20http://"+process.argv.at(-2));setInterval(()=>{},1000)`
  process.env.AH_SKEPSIS = `node --eval ${script} --`
})
vi.mock("../../platform/window.ts", () => ({
  showUrl: async (_place: string, url: string) => void shown.add(url),
  windowsShowing: (url: string) => (shown.has(url) ? [1] : []),
}))

const { openSkepsis, reap } = await import("./skepsis.ts")

const alive = (rev: string) => {
  try {
    return execFileSync("pgrep", ["-f", `http://.*${rev} --no-open`]).length > 0
  } catch {
    return false
  }
}

test("a skepsis whose window was closed is stopped at the next reap", async () => {
  await openSkepsis(process.cwd(), ["-r", "kept"], null)
  await openSkepsis(process.cwd(), ["-r", "closed"], null)
  shown.delete("http://closed")
  // Not while its window may still be on its way
  reap()
  expect(alive("closed")).toBe(true)
  reap(Date.now() + 60_000)
  await expect.poll(() => alive("closed")).toBe(false)
  expect(alive("kept")).toBe(true)
  // And a click on its diff starts it again
  await openSkepsis(process.cwd(), ["-r", "closed"], null)
  expect(alive("closed")).toBe(true)
  shown.clear()
  reap(Date.now() + 60_000)
  await expect.poll(() => alive("kept") || alive("closed")).toBe(false)
})
