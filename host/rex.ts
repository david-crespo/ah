// Rex's sessions, tabs, and terminals as a Snapshot, what every app that
// follows the terminal works from. Rex pushes events, so this follows
// `rex events --all --json` and re-reads a session's view when its
// structure or focus changes. Terminals' directories and titles come in as
// block events, so they cost nothing after a block's first read.
//
// The mapping: a Rex session is a Snapshot window, a Rex window is a tab, and
// a block is a terminal. Workspaces are tabs in one Rex session, but every
// session is included. Rex doesn't say which session the app is showing, so
// `front` is the session whose focus last moved.

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { isRecord, isString, isStringOrNull } from "./guards.ts"
import { run } from "./proc.ts"

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
  /** The session whose focus last moved */
  front: string | null
  windows: Window[]
}

export interface RexWindow {
  id: string
  label: string
  focused: string | null
  blocks: string[]
}

export interface RexView {
  activeWindow: string | null
  windows: RexWindow[]
}

export interface BlockInfo {
  cwd: string
  title: string
  /** The foreground process group's leader, which Rex calls the foreground
   * process. Not in the snapshot: it changes with every command run. */
  pid: number | null
}

/** The parts of `session.view` a snapshot needs, or null if it isn't one */
export function parseView(v: unknown): RexView | null {
  if (!isRecord(v) || !isStringOrNull(v.active_window_id) || !Array.isArray(v.windows)) {
    return null
  }
  const windows: RexWindow[] = []
  for (const w of v.windows) {
    if (!isRecord(w) || !isString(w.window_id)) return null
    const blocks: string[] = []
    for (const layer of Array.isArray(w.layers) ? w.layers : []) {
      if (!isRecord(layer) || !Array.isArray(layer.blocks)) continue
      for (const b of layer.blocks)
        if (isRecord(b) && isString(b.block_id)) blocks.push(b.block_id)
    }
    windows.push({
      id: w.window_id,
      label: isString(w.label) ? w.label : "",
      focused: isString(w.focused_block_id) ? w.focused_block_id : null,
      blocks,
    })
  }
  return { activeWindow: v.active_window_id, windows }
}

/** What the app shows as a tab's title: its label, or when it has none (the
 * view then makes one up from the id), its focused terminal's title */
export function tabName(w: RexWindow, blocks: Map<string, BlockInfo>): string {
  if (w.label && w.label !== `Window ${w.id.slice(-8)}`) return w.label
  return (w.focused && blocks.get(w.focused)?.title) || ""
}

export function toSnapshot(
  sessions: Map<string, RexView>,
  blocks: Map<string, BlockInfo>,
  front: string | null,
): Snapshot {
  return {
    front: front !== null && sessions.has(front) ? front : null,
    windows: [...sessions].map(([id, view]) => ({
      id,
      selectedTab: view.activeWindow,
      tabs: view.windows.map((w): Tab => ({
        id: w.id,
        name: tabName(w, blocks),
        focused: w.focused,
        terminals: w.blocks.map((b) => ({ id: b, cwd: blocks.get(b)?.cwd ?? "" })),
      })),
    })),
  }
}

/** The view's focus, to tell a focus move from other changes */
const focusOf = (view: RexView) =>
  `${view.activeWindow} ${view.windows.find((w) => w.id === view.activeWindow)?.focused}`

/** `rex api call`, parsed. Never starts a Rex server that isn't running. */
async function call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { success, stdout, stderr } = await run("rex", [
    "--autostart=false",
    "api",
    "call",
    method,
    JSON.stringify(args),
  ])
  if (!success) throw new Error(`rex api call ${method}: ${stderr.trim()}`)
  return JSON.parse(stdout)
}

/** Set a tab's title, which in Rex is its window's label */
export async function setWindowLabel(
  session: string,
  window: string,
  label: string,
): Promise<"set" | "failed"> {
  try {
    await call("session.set_window_label", {
      session_id: session,
      window_id: window,
      label,
    })
    return "set"
  } catch (e) {
    console.error("ah:", e)
    return "failed"
  }
}

/** Show a tab in the Rex app, leaving whichever app is in front there: the
 * click that asked for it was in the dashboard, which stays. The app keeps its
 * own selected tab and doesn't follow `session.focus_window`, so this asks it
 * to with its `session.select` action, which needs Remote Control on in its
 * settings. */
export async function selectWindow(session: string, window: string): Promise<void> {
  const list = await call("client.list")
  const app =
    isRecord(list) && Array.isArray(list.clients)
      ? list.clients.find((c) => isRecord(c) && isRecord(c.info) && c.info.kind === "app")
      : undefined
  if (!isRecord(app) || !isString(app.client_id)) throw new Error("no Rex app connected")
  const { success, stderr } = await run("rex", [
    "--autostart=false",
    "--client",
    app.client_id,
    "do",
    "session.select",
    `session_id=${session}`,
    `window_id=${window}`,
  ])
  if (!success) throw new Error(`rex do session.select: ${stderr.trim()}`)
}

/** A block's directory from a `process` result or `process_changed` event:
 * the foreground process's, which follows cds without shell integration */
const cwdOf = (p: unknown) =>
  isRecord(p) && isRecord(p.foreground) && isString(p.foreground.cwd)
    ? p.foreground.cwd
    : null

const pidOf = (p: unknown) =>
  isRecord(p) && isRecord(p.foreground) && typeof p.foreground.pid === "number"
    ? p.foreground.pid
    : null

const titleOf = (p: unknown) => (isRecord(p) && isString(p.title) ? p.title : null)

class RexState {
  sessions = new Map<string, RexView>()
  blocks = new Map<string, BlockInfo>()
  front: string | null = null
  /** Sessions with a view read in flight, and whether another is wanted after */
  #reading = new Map<string, boolean>()
  onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  snapshot = () =>
    toSnapshot(
      this.sessions,
      this.blocks,
      this.front ?? this.sessions.keys().next().value ?? null,
    )

  async load() {
    const list = await call("session.list")
    const ids =
      isRecord(list) && Array.isArray(list.sessions)
        ? list.sessions.flatMap((s) =>
            isRecord(s) && isString(s.session_id) ? [s.session_id] : [],
          )
        : []
    await Promise.all(ids.map((id) => this.readView(id)))
  }

  /** Re-read a session's view, coalescing reads asked for while one runs */
  async readView(session: string): Promise<void> {
    if (this.#reading.has(session)) {
      this.#reading.set(session, true)
      return
    }
    this.#reading.set(session, false)
    try {
      const view = parseView(await call("session.view", { session_id: session }))
      if (view) {
        const before = this.sessions.get(session)
        this.sessions.set(session, view)
        if (before && focusOf(before) !== focusOf(view)) this.front = session
        await this.readNewBlocks(session, view)
        this.onChange()
      }
    } catch (e) {
      // gone between the event and the read; session_destroyed follows
      if (!this.sessions.has(session)) return
      console.error(`ah: couldn't read Rex session ${session}:`, e)
    } finally {
      const again = this.#reading.get(session)
      this.#reading.delete(session)
      if (again) await this.readView(session)
    }
  }

  async readNewBlocks(session: string, view: RexView) {
    const blocks = view.windows.flatMap((w) => w.blocks).filter((b) => !this.blocks.has(b))
    await Promise.all(
      blocks.map(async (block) => {
        const method = (name: string) =>
          call("block.method", {
            session_id: session,
            block_id: block,
            method: name,
          }).catch(() => null)
        const [process, title] = await Promise.all([method("process"), method("title")])
        this.blocks.set(block, {
          cwd: cwdOf(process) ?? "",
          title: titleOf(title) ?? "",
          pid: pidOf(process),
        })
      }),
    )
  }

  removeSession(session: string) {
    const view = this.sessions.get(session)
    if (!view) return
    this.sessions.delete(session)
    for (const w of view.windows) for (const b of w.blocks) this.blocks.delete(b)
    if (this.front === session) this.front = null
    this.onChange()
  }

  onEvent(e: unknown) {
    if (!isRecord(e) || !isRecord(e.payload)) return
    const p = e.payload
    if (e.type === "session_created") {
      if (isRecord(p.session) && isString(p.session.session_id))
        void this.readView(p.session.session_id)
    } else if (e.type === "session_destroyed") {
      if (isString(p.session_id)) this.removeSession(p.session_id)
    } else if (e.type === "session_event" && isString(p.session_id) && isRecord(p.event)) {
      this.onSessionEvent(p.session_id, p.event)
    }
  }

  onSessionEvent(session: string, event: Record<string, unknown>) {
    const p = isRecord(event.payload) ? event.payload : {}
    switch (event.type) {
      case "session_view_changed":
      case "active_window_changed":
      case "window_label_changed":
      case "window_created":
      case "window_closed":
      case "block_created":
        return void this.readView(session)
      case "block_closed":
        if (isString(p.block_id)) this.blocks.delete(p.block_id)
        return void this.readView(session)
      case "block_event": {
        const info = isString(p.block_id) ? this.blocks.get(p.block_id) : undefined
        if (!info) return
        if (p.name === "process_changed") {
          info.pid = pidOf(p.payload)
          const cwd = cwdOf(p.payload)
          if (cwd === null || cwd === info.cwd) return
          info.cwd = cwd
        } else if (p.name === "title_changed") {
          const title = titleOf(p.payload)
          if (title === null || title === info.title) return
          info.title = title
        } else return
        return this.onChange()
      }
    }
  }
}

/** The state `watchRex` keeps, for what the snapshot leaves out */
let watched: RexState | null = null

/** Each block's foreground process group, by its leader's pid, as of the last
 * event `watchRex` saw. Any process in that group is running in that block.
 * Empty outside the server. */
export function foregroundBlocks(): Map<number, { block: string; cwd: string }> {
  const result = new Map<number, { block: string; cwd: string }>()
  for (const [block, info] of watched?.blocks ?? [])
    if (info.pid !== null) result.set(info.pid, { block, cwd: info.cwd })
  return result
}

export async function snapshotOnce(): Promise<Snapshot> {
  const state = new RexState(() => {})
  await state.load()
  return state.snapshot()
}

/** Calls `onChange` with every new snapshot, forever. Reconnects if the
 * event stream ends, e.g. when the Rex server restarts. */
export async function watchRex(onChange: (s: Snapshot) => void): Promise<never> {
  let last = ""
  const emit = (s: Snapshot) => {
    const json = JSON.stringify(s)
    if (json === last) return
    last = json
    onChange(s)
  }
  while (true) {
    let loaded = false
    const child = spawn("rex", ["--autostart=false", "events", "--all", "--json"], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(null))
      child.on("close", (code) => resolve(code))
    })
    // Load after subscribing, so no change falls between the two. Events
    // that arrive first are queued and replayed on top of the load.
    const queued: unknown[] = []
    const state: RexState = new RexState(() => loaded && emit(state.snapshot()))
    watched = state
    void state.load().then(
      () => {
        loaded = true
        for (const e of queued.splice(0)) state.onEvent(e)
        emit(state.snapshot())
      },
      (e) => {
        // Events would queue forever with nothing to replay them onto, so
        // start over with a fresh stream
        console.error("ah: couldn't load Rex sessions:", e)
        child.kill()
      },
    )
    for await (const line of createInterface({ input: child.stdout })) {
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (loaded) state.onEvent(event)
      else queued.push(event)
    }
    console.error(`ah: rex events exited with ${await exited}, restarting`)
    emit({ front: null, windows: [] })
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
