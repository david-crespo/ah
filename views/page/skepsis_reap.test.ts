import { afterAll, expect, test, vi } from "vitest"

// A skepsis that says where it's listening, with its pid as the path, and
// stays. No real windows.
const shown = new Set<string>()
const started: { rev: string; pid: number; url: string }[] = []
vi.hoisted(() => {
  // No spaces, since AH_SKEPSIS is split on them
  const script = String.raw`console.log("skepsis\x20on\x20http://"+process.argv.at(-2)+"/"+process.pid);setInterval(()=>{},1000)`
  process.env.AH_SKEPSIS = `node --eval ${script} --`
})
vi.mock("../../platform/window.ts", () => ({
  showUrl: async (_place: string, url: string) => {
    shown.add(url)
    const { host: rev, pathname } = new URL(url)
    if (!started.some((s) => s.url === url))
      started.push({ rev, pid: Number(pathname.slice(1)), url })
  },
  windowsShowing: (url: string) => (shown.has(url) ? [1] : []),
}))

const { openSkepsis, reap } = await import("./skepsis.ts")

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const alive = (rev: string) => started.some((s) => s.rev === rev && running(s.pid))

// Whatever a failed assertion left running
afterAll(() => {
  for (const { pid } of started) if (running(pid)) process.kill(pid)
})

test("a skepsis whose window was closed is stopped at the next reap", async () => {
  await openSkepsis(process.cwd(), ["-r", "kept"], null)
  await openSkepsis(process.cwd(), ["-r", "closed"], null)
  for (const s of started) if (s.rev === "closed") shown.delete(s.url)
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
