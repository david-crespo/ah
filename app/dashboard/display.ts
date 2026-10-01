// Putting a newly opened Chrome window on another display: the one you're not
// working on, taken to be whichever doesn't have the pointer. With a laptop
// under a monitor that's the laptop screen, where the dashboard is meant to
// sit. Chrome's --window-position doesn't reach a new window when Chrome is
// already running, so this finds the window by URL afterwards and sets its
// bounds over Apple events.

import { run } from "../../host/proc.ts"

// JXA, so it can read the screens from AppKit and move the window in one go.
// Cocoa frames start at the primary screen's bottom left with y going up;
// Chrome's bounds start at its top left with y going down.
const script = `
ObjC.import("AppKit")
function run([url]) {
  const mouse = $.NSEvent.mouseLocation
  const screens = $.NSScreen.screens.js
  if (screens.length < 2) return "one display"
  const contains = (s) => {
    const f = s.frame
    return mouse.x >= f.origin.x && mouse.x < f.origin.x + f.size.width &&
      mouse.y >= f.origin.y && mouse.y < f.origin.y + f.size.height
  }
  const others = screens.filter((s) => !contains(s))
  const target = others.find((s) => s.localizedName.js.startsWith("Built-in")) ?? others[0]
  const primaryHeight = screens[0].frame.size.height
  const v = target.visibleFrame
  const bounds = {
    x: v.origin.x,
    y: primaryHeight - (v.origin.y + v.size.height),
    width: v.size.width,
    height: v.size.height,
  }
  const chrome = Application("Google Chrome")
  for (let i = 0; i < 50; i++) {
    const w = chrome.windows().find((w) => w.activeTab.url().startsWith(url))
    if (w) {
      w.bounds = bounds
      return "moved to " + target.localizedName.js
    }
    delay(0.1)
  }
  return "window not found"
}
`

/** Move the Chrome window showing `url` to a display without the pointer, if
 * there is one. Returns what happened, for logging. */
export async function moveToOtherDisplay(url: string): Promise<string> {
  const { success, stdout, stderr } = await run("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
    url,
  ])
  return success ? stdout.trim() : `failed: ${stderr.trim()}`
}
