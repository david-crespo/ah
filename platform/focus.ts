// Whether a window a command opens should take focus, and opening one that
// doesn't. A person who runs a command is waiting for its window, so it comes
// to the front. An agent's command takes focus only when the person is
// looking at that agent: Rex is the frontmost app and the agent's block has
// focus in it. Otherwise the window opens behind whatever the person is doing.
//
// ah's own windows (platform/window.ts) take focus only when told to. A
// browser asked for a tab may come to the front even under `open -g`, as
// Chrome does, so a tab that shouldn't take focus is opened and then focus
// handed back to the app that had it.

import { run } from "./proc.ts"
import { appFocuses } from "./rex.ts"
import { currentAgent } from "./session.ts"

/** The frontmost app's pid, or null if there's none or lsappinfo can't say */
async function frontmostPid(): Promise<number | null> {
  try {
    const asn = (await run("lsappinfo", ["front"])).stdout.trim()
    if (!asn) return null
    const { stdout } = await run("lsappinfo", ["info", "-only", "pid", asn])
    const pid = stdout.match(/\bpid = (\d+)/)?.[1]
    return pid ? Number(pid) : null
  } catch {
    return null
  }
}

/** What's in front before a window opens, and whether the window may take
 * focus from it */
export interface Focus {
  take: boolean
  front: number | null
}

/** Whether a window opened now should take focus: yes from a shell, and from
 * an agent only when the person is in Rex with the agent's block focused */
export async function focusHere(): Promise<Focus> {
  const front = await frontmostPid()
  if (!currentAgent()) return { take: true, front }
  const session = process.env.REX_SESSION
  const block = process.env.REX_BLOCK
  if (front === null || !session || !block) return { take: false, front }
  try {
    return { take: await appFocuses(front, session, block), front }
  } catch {
    return { take: false, front }
  }
}

// JXA, since AppKit activates an app by pid without the Automation permission
// telling it to over Apple events would need
const activate = `
ObjC.import("AppKit")
function run([pid]) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid))
  return app.isNil() ? "gone" : String(app.activateWithOptions(0))
}
`

/** Bring the app with `pid` to the front. Returns why it couldn't, or null
 * if it did. */
export async function activatePid(pid: number): Promise<string | null> {
  const { stdout, stderr } = await run("osascript", [
    "-l",
    "JavaScript",
    "-e",
    activate,
    String(pid),
  ])
  return stdout.trim() === "true" ? null : stdout.trim() || stderr.trim()
}

/** After opening a tab that shouldn't take focus: wait up to 1.5s for the
 * browser to come forward, and put `front` back in front if it does */
export async function keepFocus(front: number | null) {
  if (front === null) return
  for (let i = 0; i < 30; i++) {
    const now = await frontmostPid()
    if (now !== null && now !== front) {
      const failed = await activatePid(front)
      if (failed) console.error(`ah: couldn't give focus back: ${failed}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
