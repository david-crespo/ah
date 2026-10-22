// Showing one of ah's pages in a window of its own: the native app in
// webview/, a WKWebView in a process per window, so each gets its own Dock
// tile and takes focus only when told to. The Dock names a tile after the
// app's bundle, so each name gets a copy of the bundle with that name in its
// Info.plist. The app is built here on first use and whenever its sources
// change, which takes the Xcode Command Line Tools.
//
// For a fork that wants Chrome app windows instead (Linux, say, or no Swift
// toolchain), what we learned before dropping them:
//
// - `open -na "Google Chrome" --args --app=URL` hands the window to the
//   running Chrome. Every window then shares Chrome's one Dock tile.
// - Chrome comes to the front for the new window even under `open -g`. To
//   keep focus, note the frontmost app's pid first (lsappinfo, as focus.ts
//   does), wait for Chrome to come forward, and activate the pid again with
//   AppKit's NSRunningApplication.activateWithOptions from JXA (focus.ts's
//   keepFocus). `lsappinfo setfront` fails with permErr. There's still a
//   moment when Chrome has the keyboard.
// - `--window-position` doesn't reach a new window of a Chrome that's already
//   running. To put the window on another display, find it afterwards over
//   Apple events, by the URL of its activeTab, and set its bounds: Chrome's
//   bounds start at the primary screen's top left with y going down, while
//   NSScreen frames start at its bottom left with y going up.

import { cpSync, existsSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { assetPath } from "./assets.ts"
import { die } from "./cli.ts"
import { type Focus, activatePid, focusHere, keepFocus } from "./focus.ts"
import { ahStateDir } from "./paths.ts"
import { processTable, run } from "./proc.ts"

export interface WindowOptions {
  /** What the Dock calls it */
  name: string
  /** The Dock icon's text and color, a #rrggbb */
  badge: string
  color: string
  /** Fill a display without the pointer, if there is one */
  otherDisplay?: boolean
}

const BINARY = "Contents/MacOS/ah-webview"
const SOURCES = ["webview/main.swift", "webview/Info.plist", "webview/build.sh"]

const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0)

/** The app, built first if it's missing or older than its sources */
async function builtApp(): Promise<string> {
  const app = assetPath("webview/build/ah.app")
  const built = mtime(join(app, BINARY))
  if (built && SOURCES.every((s) => mtime(assetPath(s)) <= built)) return app
  console.error("ah: building the window app (webview/build.sh)")
  const { success, stderr } = await run(assetPath("webview/build.sh"), [])
  if (!success) die(`ah: couldn't build the window app:\n${stderr.trim()}`)
  return app
}

/** A copy of the app whose bundle is named `name`, made again when the app
 * is rebuilt */
async function namedApp(base: string, name: string): Promise<string> {
  const app = ahStateDir("windows", `${name.replace(/[/:]/g, "-")}.app`)
  if (mtime(join(app, BINARY)) >= mtime(join(base, BINARY))) return app
  rmSync(app, { recursive: true, force: true })
  cpSync(base, app, { recursive: true })
  const plist = join(app, "Contents/Info.plist")
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    await run("plutil", ["-replace", key, "-string", name, plist])
  }
  // The copy's Info.plist no longer matches the signature
  await run("codesign", ["--force", "--sign", "-", app])
  return app
}

const SHOWING = /\/ah-webview --url (\S+)/

/** The pids of the windows showing `url`, oldest first */
function windowsShowing(url: string): number[] {
  return processTable().flatMap((p) => (p.args.match(SHOWING)?.[1] === url ? [p.pid] : []))
}

/** Bring the newest window showing `url` to the front. Returns whether there
 * was one. */
export async function focusWindow(url: string): Promise<boolean> {
  const pid = windowsShowing(url).at(-1)
  if (pid === undefined) return false
  const failed = await activatePid(pid)
  if (failed) console.error(`ah: couldn't bring the window forward: ${failed}`)
  return true
}

/** Open `url` in a window, in front only if `focus` says it may take focus.
 * With `live`, a page of `url` is connected, and a window already showing it
 * comes forward instead (if `focus` allows); without it, any window still
 * showing `url` has a page that gave up, and it's quit. */
export async function openWindow(
  url: string,
  options: WindowOptions,
  focus: Focus,
  live = false,
) {
  if (live && windowsShowing(url).length) {
    if (focus.take) await focusWindow(url)
    return
  }
  for (const pid of windowsShowing(url)) process.kill(pid)
  const app = await namedApp(await builtApp(), options.name)
  // An app's own activate() is ignored after a -g launch (since macOS 14,
  // activation is the app in front's to give), so launching is what brings it
  // forward. -g keeps LaunchServices from doing that, and -n from reusing a
  // running one.
  await run("open", [
    ...(focus.take ? [] : ["-g"]),
    "-n",
    app,
    "--args",
    "--url",
    url,
    "--badge",
    options.badge,
    "--color",
    options.color,
    ...(focus.take ? ["--focus"] : []),
    ...(options.otherDisplay ? ["--other-display"] : []),
  ])
}

/** `url` in a window of its own or a tab of the default browser, taking
 * focus only as `focusHere` allows. With `live`, a window already showing it
 * comes forward instead (see openWindow). */
export async function showUrl(
  place: "window" | "tab",
  url: string,
  options: WindowOptions,
  live = false,
) {
  const focus = await focusHere()
  if (place === "window") {
    await openWindow(url, options, focus, live)
  } else if (focus.take) {
    await run("open", [url])
  } else {
    await run("open", ["-g", url])
    await keepFocus(focus.front)
  }
}

/** A file's window name: its own name, or its directory's for an index.html,
 * less the date notes start with */
export function windowName(path: string): string {
  const name = basename(path) === "index.html" ? basename(dirname(path)) : basename(path)
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "")
}
