// Core types. Ids are plain strings, named for what they identify.

// Rex

/** Rex's id for a block */
export type BlockId = string
/** Rex's id for a window, which ah calls a tab */
export type TabId = string
/** Rex's id for a session, a group of tabs */
export type RexSessionId = string

/** One application in a tab, usually a terminal */
export interface Block {
  id: BlockId
  cwd: string
}

/** A Rex window: a layout of blocks */
export interface Tab {
  id: TabId
  name: string
  /** null when the tab has no focused block, e.g. right after its focused pane closes */
  focused: BlockId | null
  blocks: Block[]
}

/** A Rex session: a group of tabs, one of them selected */
export interface RexSession {
  id: RexSessionId
  selectedTab: TabId | null
  tabs: Tab[]
}

/** ah's copy of Rex's layout and focus, kept current from `rex events`. In
 * memory only. Every session is included; workspaces are tabs in one. */
export interface RexState {
  /** The session whose focus last moved. Rex doesn't say which one the app is
   * showing. */
  front: RexSessionId | null
  sessions: RexSession[]
}

/** A jj workspace, by its root. A directory resolves to the one it's in; a
 * tab's comes from its blocks' cwd. */
export type WorkspaceRoot = string

// Agents

export const HARNESSES = ["claude", "codex", "opencode", "pi"] as const
/** A coding agent CLI ah works with */
export type Harness = (typeof HARNESSES)[number]

/** Where ah posts messages to a harness session. pi has none: ah can't
 * post into it. */
export type Address =
  | {
      harness: "claude"
      /** Its inbox socket */
      socket: string
    }
  /** `pid` is the TUI's process, if it could be found, since Codex keeps no
   * record of which threads are running */
  | { harness: "codex"; thread: string; pid: number | null }
  | { harness: "opencode"; id: string }

/** Where an agent runs. Outside Rex, the harness process stands in for the
 * block. */
export type Home = { kind: "block"; block: BlockId } | { kind: "process"; process: string }

/** An agent's id, from its home: its block id, or its process key. An agent
 * with no home has `<harness>:<session>`. */
export type AgentId = string

/** What a command or hook run by an agent knows about which one it is */
export interface AgentRef {
  harness: Harness
  session: string | null
  /** REX_BLOCK */
  block: BlockId | null
  /** platform/session.ts's process key, for agents outside Rex */
  process: string | null
}

/** A live agent in a shell's tab, as `/core/agents-near` lists it for the
 * shell to pick from */
export interface NearbyAgent {
  id: AgentId
  harness: Harness
  /** Its part of the tab title: the label, then the summary */
  label: string
  summary: string | null
  busy: boolean
  /** Whether a send from the shell without an agent named goes to it */
  target: boolean
}

// Trackers

/** Where a tracker is. Active ones are listed and can be current; parked
 * ones have work left but are out of view until resumed or added again (an
 * active one unopened for 7 days is parked); done ones have none left.
 * Adding one makes it active and current, whatever it was. */
export type TrackerStatus = "active" | "parked" | "done"

/** A tracker whose work isn't done */
export interface TrackerEntry {
  subject: Requestable
  /** When it was last open in a view, ms since the epoch */
  lastOpen: number
}

/** A workspace's trackers, as views see them. Per workspace rather than
 * per tab so it works outside Rex; two tabs on one workspace share the
 * current one. Done ones aren't listed. */
export interface WorkspaceTrackers {
  /** What "the tracker" means here, and what the dashboard shows */
  current: Requestable | null
  active: TrackerEntry[]
  parked: TrackerEntry[]
}

/** A tracker as ah keeps it */
export interface TrackerRecord {
  path: string
  /** As marked: one gone a week unused is parked without being marked so */
  status: TrackerStatus
  /** When it was last made current or resumed, ms since the epoch. Says
   * which one takes over when the current one leaves, and with the file's
   * last change, whether it's gone a week unused. */
  used: number
}

/** A workspace's trackers as ah keeps them */
export interface WorkspaceRecord {
  current: string | null
  trackers: TrackerRecord[]
}

// Subjects and requests

/** A jj change id. Only diff subjects use it, which aren't built yet. */
export type ChangeId = string

/** The kinds of subject that are files. A file's is by its extension. */
export const FILE_KINDS = ["markdown", "html"] as const
export type FileKind = (typeof FILE_KINDS)[number]

/** A file's kind: html for .html and .htm, markdown for anything else */
export const fileKind = (path: string): FileKind =>
  /\.html?$/i.test(path) ? "html" : "markdown"

/** What a view ah hosts or binds is about. The kind is the subject's type,
 * which decides the views that can show it. A file's is by extension: html
 * or markdown. An html page is its own view, and decides what it is (a task
 * list, say) and the requests it sends. Views Rex places without ah (the
 * harness TUI, glow) aren't covered.
 *
 * Partly a target rather than what the code does: only the file kinds are
 * built, and code that handles them mostly takes a path and a `FileKind`. */
export type Subject =
  | { kind: "markdown"; path: string }
  | { kind: "html"; path: string }
  /** Not built: there's no diff view yet */
  | { kind: "diff"; from: ChangeId; to: ChangeId }
  /** Not used as values yet: the dashboard shows the focused tab and its
   * workspace without naming them as subjects. Same for the two below. */
  | { kind: "workspace"; root: WorkspaceRoot }
  | { kind: "tab"; tab: TabId }
  | { kind: "rex-session"; session: RexSessionId }

/** A subject that takes requests and has a bound agent. Today that's
 * always a file, kept by path (trackers, open files, thread logs); diff is
 * here for when it's built. */
export type Requestable = Extract<Subject, { kind: FileKind | "diff" }>

export type RequestId = string

/** A message from a view to the agent about its subject. `kind` and `args`
 * belong to the subject's type; the core passes them through. */
export interface Request {
  type: "request"
  id: RequestId
  kind: string
  text?: string
  args: Record<string, string>
  replyTo?: RequestId
  at: string
}

export const PHASES = [
  "start",
  "progress",
  "reply",
  "done",
  "needs-reply",
  "error",
] as const

/** The agent's report on requests it's handling */
export interface Activity {
  type: "activity"
  id: string
  requests: RequestId[]
  phase: (typeof PHASES)[number]
  workId?: string
  text?: string
  at: string
}

/** One line of a requestable subject's request log */
export type ThreadEntry = (Request | Activity) & { seq: number }

/** Where a request stands, worked out from the log */
export type RequestStatus =
  | "waiting"
  | "working"
  | "done"
  | "needs-reply"
  | "error"
  | "interrupted"

/** A request's status, with the work it's part of and when it last changed */
export interface RequestState {
  id: RequestId
  status: RequestStatus
  workId?: string
  updatedAt: string
}
