// Ghostty's tabs and their terminals' working directories, read over its
// scripting interface, and setting a tab's title. Ghostty sends no events, so this polls: one
// long-running JXA process loops and prints a JSON line to stdout only when
// the answer changes, which avoids paying osascript startup (~130ms) per tick.

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { isRecord, isString, isStringOrNull } from "../../host/guards.ts"
import { run } from "../../host/proc.ts"

export interface Terminal {
  id: string
  cwd: string
}

export interface Tab {
  id: string
  name: string
  /** null when the tab has no focused terminal, e.g. right after its focused pane closes */
  focused: string | null
  terminals: Terminal[]
}

export interface Window {
  id: string
  selectedTab: string | null
  tabs: Tab[]
}

export interface Snapshot {
  /** Ghostty's frontmost window, even when another app is frontmost */
  front: string | null
  windows: Window[]
}

const isTerminal = (v: unknown): v is Terminal =>
  isRecord(v) && isString(v.id) && isString(v.cwd)

const isTab = (v: unknown): v is Tab =>
  isRecord(v) &&
  isString(v.id) &&
  isString(v.name) &&
  isStringOrNull(v.focused) &&
  Array.isArray(v.terminals) &&
  v.terminals.every(isTerminal)

const isWindow = (v: unknown): v is Window =>
  isRecord(v) &&
  isString(v.id) &&
  isStringOrNull(v.selectedTab) &&
  Array.isArray(v.tabs) &&
  v.tabs.every(isTab)

/** The poller's output is ours, but a Ghostty update can change what its
 * scripting dictionary returns */
const isSnapshot = (v: unknown): v is Snapshot =>
  isRecord(v) &&
  isStringOrNull(v.front) &&
  Array.isArray(v.windows) &&
  v.windows.every(isWindow)

// Every Apple event costs a round trip to Ghostty, and a full read with one
// event per property took ~480ms for 5 tabs. So the loop splits the work:
//
// - Every tick (200ms by default), only the front window's selected tab. In
//   JXA only the final call in a specifier chain sends an event, so that's
//   one event.
// - The full read (tabs, terminals, directories) when the selected tab is one
//   it hasn't seen, and every 2s otherwise to catch new tabs and cds. It asks
//   for whole lists per event (g.windows.tabs.name() returns an array per
//   window) and falls back to one event per property if Ghostty refuses.
//
// `run(argv)`: "once" prints one snapshot plus timings, "loop <ms>" loops.
// Touching any property of a JXA Application launches the app, so every
// event is preceded by a `running()` check (`live`), which doesn't. Checking
// once per tick isn't enough: Ghostty can exit partway through a read, and the
// next event relaunches it. Nothing tells another process that an app is
// quitting, so this narrows the window rather than closing it. A read that
// throws (a tab closing mid-read, or Ghostty gone) is skipped.
const SCRIPT = String.raw`
ObjC.import("Foundation")

function attempt(f) {
  try { return f() } catch (e) { return null }
}
const str = (x) => (x == null ? null : String(x))

function live(g) {
  if (!g.running()) throw new Error("Ghostty is not running")
}

function frontTab(g) {
  return attempt(() => (live(g), str(g.frontWindow.selectedTab.id())))
}

function bulk(g) {
  const W = g.windows
  live(g)
  const windowIds = W.id()
  live(g)
  const tabIds = W.tabs.id()
  live(g)
  const names = W.tabs.name()
  live(g)
  const terminalIds = W.tabs.terminals.id()
  live(g)
  const cwds = W.tabs.terminals.workingDirectory()
  // fail as a whole if any window or tab lacks one, so retry those one by one
  const selected = attempt(() => (live(g), W.selectedTab.id()))
  const focused = attempt(() => (live(g), W.tabs.focusedTerminal.id()))
  return windowIds.map((id, i) => ({
    id: String(id),
    selectedTab: selected
      ? str(selected[i])
      : attempt(() => (live(g), str(W[i].selectedTab.id()))),
    tabs: tabIds[i].map((tabId, j) => ({
      id: String(tabId),
      name: names[i][j],
      focused: focused
        ? str(focused[i][j])
        : attempt(() => (live(g), str(W[i].tabs[j].focusedTerminal.id()))),
      terminals: terminalIds[i][j].map((terminalId, k) => ({
        id: String(terminalId),
        cwd: cwds[i][j][k] || "",
      })),
    })),
  }))
}

// The fallback sends one event per property, so check before each
function perElement(g) {
  const ask = (f) => (live(g), f())
  return ask(() => g.windows()).map((w) => ({
    id: String(ask(() => w.id())),
    selectedTab: attempt(() => String(ask(() => w.selectedTab().id()))),
    tabs: ask(() => w.tabs()).map((t) => ({
      id: String(ask(() => t.id())),
      name: ask(() => t.name()),
      focused: attempt(() => String(ask(() => t.focusedTerminal().id()))),
      terminals: ask(() => t.terminals()).map((x) => ({
        id: String(ask(() => x.id())),
        cwd: ask(() => x.workingDirectory()) || "",
      })),
    })),
  }))
}

function readWindows(g) {
  try {
    return bulk(g)
  } catch (e) {
    live(g)
    return perElement(g)
  }
}

function hasTab(windows, tabId) {
  return windows.some((w) => w.tabs.some((t) => t.id === tabId))
}

// The front window is whichever has the selected tab; patch its selection in,
// since the cached windows can be up to 2s old.
function assemble(windows, selected) {
  const front = windows.find((w) => w.tabs.some((t) => t.id === selected))
  return {
    front: front ? front.id : null,
    windows: windows.map((w) => (w === front ? { ...w, selectedTab: selected } : w)),
  }
}

function emit(s) {
  const out = $.NSFileHandle.fileHandleWithStandardOutput
  out.writeData($(s + "\n").dataUsingEncoding($.NSUTF8StringEncoding))
}

function timed(f) {
  const start = Date.now()
  const value = f()
  return [value, Date.now() - start]
}

function once(g) {
  if (!g.running()) return { snapshot: { front: null, windows: [] }, timing: null }
  const [selected, frontTabMs] = timed(() => frontTab(g))
  let bulkMs = null
  let bulkError = null
  try {
    bulkMs = timed(() => bulk(g))[1]
  } catch (e) {
    bulkError = String(e)
  }
  const [windows, perElementMs] = timed(() => perElement(g))
  return {
    snapshot: assemble(windows, selected),
    timing: { frontTabMs, bulkMs, bulkError, perElementMs },
  }
}

function run(argv) {
  const g = Application("Ghostty")
  if (argv[0] === "once") {
    emit(JSON.stringify(once(g)))
    return
  }
  const intervalMs = Number(argv[1])
  let cached = null
  let cachedAt = 0
  let last = ""
  while (true) {
    let snapshot = null
    if (!g.running()) {
      cached = null
      snapshot = { front: null, windows: [] }
    } else {
      const selected = frontTab(g)
      const known = cached && (selected === null || hasTab(cached, selected))
      if (!known || Date.now() - cachedAt > 2000) {
        const windows = attempt(() => readWindows(g))
        if (windows) {
          cached = windows
          cachedAt = Date.now()
        }
      }
      if (cached) snapshot = assemble(cached, selected)
    }
    const s = snapshot && JSON.stringify(snapshot)
    if (s && s !== last) {
      emit(s)
      last = s
    }
    delay(intervalMs / 1000)
  }
}
`

const osascriptArgs = (...mode: ["once"] | ["loop", number]) => [
  "-l",
  "JavaScript",
  "-e",
  SCRIPT,
  ...mode.map(String),
]

export async function snapshotOnce(): Promise<{
  snapshot: Snapshot
  /** How long the reads took (`{ frontTabMs, bulkMs, bulkError,
   * perElementMs }`, or null when Ghostty isn't running), only printed */
  timing: unknown
}> {
  const { success, code, stdout } = await run("osascript", osascriptArgs("once"))
  if (!success) throw new Error(`osascript exited with ${code}`)
  const out: unknown = JSON.parse(stdout)
  if (!isRecord(out) || !isSnapshot(out.snapshot)) {
    throw new Error("unexpected snapshot from osascript")
  }
  return { snapshot: out.snapshot, timing: out.timing }
}

/** Calls `onChange` with every new snapshot, forever. Restarts the poller if it dies. */
export async function watchGhostty(
  intervalMs: number,
  onChange: (s: Snapshot) => void,
): Promise<never> {
  while (true) {
    const child = spawn("osascript", osascriptArgs("loop", intervalMs), {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(null))
      child.on("close", (code) => resolve(code))
    })
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line) continue
      let snapshot: unknown
      try {
        snapshot = JSON.parse(line)
      } catch {
        snapshot = null
      }
      if (!isSnapshot(snapshot)) {
        console.error(`ah: unreadable line from the Ghostty poller: ${line}`)
        continue
      }
      onChange(snapshot)
    }
    const code = await exited
    console.error(`ah: Ghostty poller exited with ${code}, restarting`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

const SET_TAB_TITLE = `
on run argv
  set targetTabId to item 1 of argv
  set targetTerminalId to item 2 of argv
  set newTitle to item 3 of argv
  -- a tell block launches Ghostty if it isn't running
  if application "Ghostty" is not running then return "not-found"
  tell application "Ghostty"
    repeat with targetWindow in windows
      repeat with targetTab in tabs of targetWindow
        repeat with targetTerminal in terminals of targetTab
          if (id of targetTerminal as text) is targetTerminalId then
            if (id of targetTab as text) is not targetTabId then return "moved"
            perform action ("set_tab_title:" & newTitle) on targetTerminal
            return "set"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`

/**
 * Set a tab's title, through one of its terminals, since Ghostty's
 * set_tab_title is an action performed on a terminal. Checks the terminal is
 * still in that tab first: the snapshot the caller went by can be up to 2s
 * old, and a pane dragged to another tab since would retitle the wrong one.
 */
export async function setTabTitle(
  tab: string,
  terminal: string,
  title: string,
): Promise<"set" | "moved" | "not-found" | "failed"> {
  const { success, stdout } = await run("osascript", [
    "-e",
    SET_TAB_TITLE,
    tab,
    terminal,
    title,
  ])
  if (!success) return "failed"
  const result = stdout.trim()
  return result === "set" || result === "moved" ? result : "not-found"
}

const TERMINAL_FOR_TTY = `
on run argv
  set targetTty to item 1 of argv
  -- a tell block launches Ghostty if it isn't running
  if application "Ghostty" is not running then return ""
  tell application "Ghostty"
    repeat with targetWindow in windows
      repeat with targetTab in tabs of targetWindow
        repeat with targetTerminal in terminals of targetTab
          if (tty of targetTerminal as text) is targetTty then return id of targetTerminal as text
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
`

/** The terminal whose controlling tty this is, e.g. /dev/ttys009. A new
 * shell finds itself this way, not by focus: when Ghostty restores a session,
 * every shell starts at once and focus says nothing about which is which. */
export async function terminalForTty(tty: string): Promise<string | null> {
  const { success, stdout } = await run("osascript", ["-e", TERMINAL_FOR_TTY, tty])
  return (success && stdout.trim()) || null
}
