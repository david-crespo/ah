// Rex's sessions, tabs, and blocks as a RexState, what everything that
// follows focus works from. Rex pushes events, so this follows
// `rex events --all --json` and re-reads a session's view when its
// structure or focus changes. Blocks' directories and titles come in as
// block events, so they cost nothing after a block's first read.
//
// The mapping: a Rex session keeps its name, a Rex window is a tab, and a
// block keeps its name. Workspaces are tabs in one Rex session, but every
// session is included. Rex doesn't say which session the app is showing, so
// `front` is the session whose focus last moved.
//
// It also keeps how the server's dealings with Rex are going (RexHealth), for
// `ah server status` and the dashboard's dot, since both can fail while the
// server itself is fine.

import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { RexState, Tab } from "../core/model.ts"
import { isRecord, isString, isStringOrNull } from "./guards.ts"
import { type Output, run } from "./proc.ts"

export interface RexHealth {
  /** The `rex` the server runs: from its PATH until that fails to start */
  binary: string
  /** `rex events`, which everything following focus works from. Times are
   * ms since the epoch. */
  events: {
    connected: boolean
    lastEventAt: number | null
    /** Restarts after the first start */
    reconnects: number
  }
  /** The last `rex` command run besides the event stream, and its error if it
   * failed */
  lastCall: { at: number; error: string | null } | null
  /** Why `rex` couldn't be started at all, until it next starts */
  unrunnable: string | null
}

const health: RexHealth = {
  binary: "rex",
  events: { connected: false, lastEventAt: null, reconnects: 0 },
  lastCall: null,
  unrunnable: null,
}
let onHealth: () => void = () => {}

export const rexHealth = (): RexHealth => structuredClone(health)

/** Called when the stream connects or drops, or `rex` stops or starts
 * running, not on every event */
export function onRexHealth(listener: () => void) {
  onHealth = listener
}

/** What's wrong for the dashboard's dot, or null if nothing is. A call Rex
 * answered with an error isn't trouble: a session can go between an event and
 * the read it prompts. */
export function rexTrouble(h: RexHealth): string | null {
  if (h.unrunnable) return h.unrunnable
  if (!h.events.connected) return "rex events isn't running"
  return null
}

function setUnrunnable(reason: string | null) {
  if (health.unrunnable === reason) return
  health.unrunnable = reason
  onHealth()
}

const isNotFound = (e: unknown) => isRecord(e) && e.code === "ENOENT"

const readdir = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Where Rex keeps its CLI now: in the newest server version it has installed,
 * else in the app bundle's helper. For a server that outlived a Rex update,
 * whose PATH names a version directory that's gone. A shell started after the
 * update gets the new one.
 */
export function findRex(home = homedir(), apps = "/Applications"): string | null {
  const versions = join(
    home,
    "Library/Application Support/com.superlogical.rex/RexServer/Versions",
  )
  const helpers = (app: string) => join(apps, app, "Contents/Helpers")
  const candidates = [
    ...readdir(versions)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a))
      .flatMap((v) => readdir(join(versions, v)).map((b) => join(versions, v, b))),
    ...readdir(apps)
      .filter((a) => /^Rex.*\.app$/.test(a))
      .flatMap((a) => readdir(helpers(a)).map((h) => join(helpers(a), h))),
  ]
  return (
    candidates.map((bundle) => join(bundle, "Contents/MacOS/rex")).find(existsSync) ?? null
  )
}

/** Look for `rex` again after `tried` failed to start. Returns whether
 * there's a new one to try, which there is if another failure already found
 * it. */
function refind(tried: string, e: unknown): boolean {
  if (health.binary !== tried) return true
  const found = isNotFound(e) ? findRex() : null
  if (found === null || found === tried) {
    setUnrunnable(`can't run ${tried}: ${e instanceof Error ? e.message : e}`)
    return false
  }
  console.error(`ah: ${tried} is gone, running ${found} instead`)
  health.binary = found
  return true
}

/** Run `rex`, noting how it went */
async function runRex(args: string[]): Promise<Output> {
  const binary = health.binary
  let out: Output
  try {
    out = await run(binary, args)
  } catch (e) {
    if (refind(binary, e)) return runRex(args)
    health.lastCall = { at: Date.now(), error: e instanceof Error ? e.message : String(e) }
    throw e
  }
  health.lastCall = { at: Date.now(), error: out.success ? null : out.stderr.trim() }
  setUnrunnable(null)
  return out
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
   * process. Not in the RexState: it changes with every command run. */
  pid: number | null
}

/** The blocks in a layer's split tree, before each split's after: top to
 * bottom and left to right */
function layoutOrder(node: unknown): string[] {
  if (!isRecord(node)) return []
  if (isString(node.block_id)) return [node.block_id]
  const split = node.split
  return isRecord(split) ? [...layoutOrder(split.before), ...layoutOrder(split.after)] : []
}

/** The parts of `session.view` a RexState needs, or null if it isn't one */
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
      // A tiled layer's in the order its split tree lays them out, then any
      // the tree doesn't have
      const laidOut = layoutOrder(layer.layout)
      const listed = layer.blocks.flatMap((b) =>
        isRecord(b) && isString(b.block_id) ? [b.block_id] : [],
      )
      blocks.push(
        ...laidOut.filter((b) => listed.includes(b)),
        ...listed.filter((b) => !laidOut.includes(b)),
      )
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
 * view then makes one up from the id), its focused block's title */
export function tabName(w: RexWindow, blocks: Map<string, BlockInfo>): string {
  if (w.label && w.label !== `Window ${w.id.slice(-8)}`) return w.label
  return (w.focused && blocks.get(w.focused)?.title) || ""
}

export function toRexState(
  sessions: Map<string, RexView>,
  blocks: Map<string, BlockInfo>,
  front: string | null,
): RexState {
  return {
    front: front !== null && sessions.has(front) ? front : null,
    sessions: [...sessions].map(([id, view]) => ({
      id,
      selectedTab: view.activeWindow,
      tabs: view.windows.map((w): Tab => ({
        id: w.id,
        name: tabName(w, blocks),
        focused: w.focused,
        blocks: w.blocks.map((b) => ({ id: b, cwd: blocks.get(b)?.cwd ?? "" })),
      })),
    })),
  }
}

/** The view's focus, to tell a focus move from other changes */
const focusOf = (view: RexView) =>
  `${view.activeWindow} ${view.windows.find((w) => w.id === view.activeWindow)?.focused}`

/** `rex api call`, parsed. Never starts a Rex server that isn't running. */
async function call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { success, stdout, stderr } = await runRex([
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
export async function setTabLabel(
  session: string,
  tab: string,
  label: string,
): Promise<"set" | "failed"> {
  try {
    await call("session.set_window_label", {
      session_id: session,
      window_id: tab,
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
export async function selectTab(session: string, tab: string): Promise<void> {
  const list = await call("client.list")
  const app =
    isRecord(list) && Array.isArray(list.clients)
      ? list.clients.find((c) => isRecord(c) && isRecord(c.info) && c.info.kind === "app")
      : undefined
  if (!isRecord(app) || !isString(app.client_id)) throw new Error("no Rex app connected")
  const { success, stderr } = await runRex([
    "--autostart=false",
    "--client",
    app.client_id,
    "do",
    "session.select",
    `session_id=${session}`,
    `window_id=${tab}`,
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

/** Follows Rex: the views and blocks a RexState is made from, updated from
 * events */
class Follower {
  sessions = new Map<string, RexView>()
  blocks = new Map<string, BlockInfo>()
  front: string | null = null
  /** Sessions with a view read in flight, and whether another is wanted after */
  #reading = new Map<string, boolean>()
  onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  state = (): RexState =>
    toRexState(
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

/** The follower `watchRex` keeps, for what the RexState leaves out */
let watched: Follower | null = null

/** Each block's foreground process group, by its leader's pid, as of the last
 * event `watchRex` saw. Any process in that group is running in that block.
 * Empty outside the server. */
export function foregroundBlocks(): Map<number, { block: string; cwd: string }> {
  const result = new Map<number, { block: string; cwd: string }>()
  for (const [block, info] of watched?.blocks ?? [])
    if (info.pid !== null) result.set(info.pid, { block, cwd: info.cwd })
  return result
}

export async function readRex(): Promise<RexState> {
  const follower = new Follower(() => {})
  await follower.load()
  return follower.state()
}

/** Calls `onChange` with every new RexState, forever. Reconnects if the
 * event stream ends, e.g. when the Rex server restarts. */
export async function watchRex(onChange: (rex: RexState) => void): Promise<never> {
  let last = ""
  const emit = (rex: RexState) => {
    const json = JSON.stringify(rex)
    if (json === last) return
    last = json
    onChange(rex)
  }
  for (let attempt = 0; ; attempt++) {
    let loaded = false
    if (attempt > 0) health.events.reconnects++
    const binary = health.binary
    const child = spawn(binary, ["--autostart=false", "events", "--all", "--json"], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const setConnected = (connected: boolean) => {
      if (health.events.connected === connected) return
      health.events.connected = connected
      onHealth()
    }
    child.on("spawn", () => {
      setConnected(true)
      setUnrunnable(null)
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", (e) => {
        refind(binary, e)
        resolve(null)
      })
      child.on("close", (code) => resolve(code))
    })
    // Load after subscribing, so no change falls between the two. Events
    // that arrive first are queued and replayed on top of the load.
    const queued: unknown[] = []
    const follower: Follower = new Follower(() => loaded && emit(follower.state()))
    watched = follower
    void follower.load().then(
      () => {
        loaded = true
        for (const e of queued.splice(0)) follower.onEvent(e)
        emit(follower.state())
      },
      (e) => {
        // Events would queue forever with nothing to replay them onto, so
        // start over with a fresh stream
        console.error("ah: couldn't load Rex sessions:", e)
        child.kill()
      },
    )
    for await (const line of createInterface({ input: child.stdout })) {
      health.events.lastEventAt = Date.now()
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (loaded) follower.onEvent(event)
      else queued.push(event)
    }
    const code = await exited
    setConnected(false)
    console.error(`ah: rex events exited with ${code}, restarting`)
    emit({ front: null, sessions: [] })
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
