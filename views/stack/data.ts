// A stack page's data, which client.ts draws: the PRs in the stack file
// next to the page, filled in from jj. The file is jjack's, parsed by jjack:
// each entry's tip, a local bookmark or a change ID, its body file and title,
// and what jjack writes as it pushes, which ah only reads. ah's own keys are
// the file's title and notes, which jjack keeps. The rest comes from the
// graph. Commits above trunk are grouped by which PRs' tips have them. A PR's
// own are the ones its tip's commit is grouped with: no PR below it has them.
// Any other group is commits below a fork that no PR's tip is on, which the
// PRs above share.

import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  type Entry,
  entryText,
  openLocalContext,
  parseStackFile as parseJjackFile,
  resolveStack,
} from "jjack"
import { rootFinder } from "../../core/workspace.ts"
import { jj, opHeadsDir } from "../../platform/jj.ts"
import { isString } from "../../platform/guards.ts"

export const STACK_FILE = "stack.json"

/** jjack's entries, with ah's keys */
export interface StackFile {
  title?: string
  notes?: string[]
  prs: Entry[]
}

/** A file's change: A, M, D, R or C, and its lines added and removed */
export interface FileStat {
  path: string
  status: string
  add: number
  del: number
}

export interface Commit {
  change: string
  /** The change ID's shortest unique prefix, at least 4 long */
  short: string
  commit: string
  description: string
  files: FileStat[]
  /** On a PR's commit still to push, when what jjack last pushed has an
   * earlier version of it: what changed since */
  rewrite?: Rewrite
}

/** What jj interdiff shows: the lines the newer diff adds and removes over
 * the earlier one's, so a new parent doesn't count, and whether a description
 * changed */
export interface Changes {
  add: number
  del: number
  reworded: boolean
}

/** How a commit differs from its earlier version. Nothing changed when it
 * was only rebased. */
export interface Rewrite extends Changes {
  /** The earlier version's commit ID, among the pushed commit's ancestors */
  from: string
}

/** Commits drawn as one card, newest first. `head` is its newest commit and
 * `base` the commit below its oldest, each by a PR's tip on it, else a
 * bookmark, else its change ID. */
export interface Group {
  head: string
  base: string
  /** Revsets for its diff, from its base to its head, quoted as needed;
   * null without commits */
  diff: { from: string; to: string } | null
  files: FileStat[]
  commits: Commit[]
}

/** A PR with no commits of its own has an empty base */
export interface Pr extends Group {
  /** Its place in the stack, from 1 at the bottom */
  n: number
  tip: string
  /** Its title as jjack pushes it: its body file's heading, else its title
   * in the file */
  title: string
  /** Its body file, relative to the stack file */
  body: string | null
  /** Its number on GitHub, once jjack has opened it */
  pr: number | null
  /** jjack has marked it merged, and leaves it out */
  merged: boolean
  /** Its tip is neither a bookmark on one commit nor a change ID of one, so
   * it has no commits */
  missing: boolean
  /** The tip's commit when jjack last pushed it, while that's still here */
  pushed: string | null
  /** How many of its commits aren't among the pushed commit's ancestors:
   * none without one. Ancestors of a pushed commit are pushed too, so these
   * are the newest. */
  unpushed: number
  /** With commits still to push: revsets for its commits as pushed and its
   * commits now, for jj interdiff, and what that shows */
  interdiff: (Changes & { from: string; to: string }) | null
}

/** Commits below a fork that no PR's tip is on */
export interface Shared extends Group {
  /** The lowest PRs that have them, so each would include them on GitHub */
  prs: number[]
}

/** `rows` are the PRs and shared groups newest first, like jj log: each
 * below the ones built on it, and of the ones built on the same one, the
 * one leading to the highest PR first. PRs whose tip isn't found come first
 * and PRs with no commits of their own, like merged ones, last. */
export interface Stack {
  /** Empty when the file has none */
  title: string
  notes: string[]
  rows: (Pr | Shared)[]
}

/** A stack file's text, parsed by jjack, with ah's keys from the ones
 * jjack doesn't know */
export function parseStackFile(text: string): StackFile {
  let file: ReturnType<typeof parseJjackFile>
  try {
    file = parseJjackFile(text)
  } catch (e) {
    throw new Error(`${STACK_FILE}: ${(e as Error).message}`)
  }
  const { title, notes } = file.other
  if (title !== undefined && !isString(title))
    throw new Error(`the title in ${STACK_FILE} must be a string`)
  if (notes !== undefined && !(Array.isArray(notes) && notes.every(isString)))
    throw new Error(`notes in ${STACK_FILE} must be a list of strings`)
  return { title, notes, prs: file.prs }
}

// One JSON object per commit, with each file's line counts
const COMMIT = [
  `'{"change":' ++ json(change_id.short(8))`,
  `',"short":' ++ json(stringify(change_id.shortest(4)))`,
  `',"commit":' ++ json(commit_id)`,
  `',"description":' ++ json(description)`,
  `',"files":[' ++ self.diff().stat().files().map(|f| '{"path":' ++ json(f.path().display()) ++ ',"status":' ++ json(f.status()) ++ ',"add":' ++ f.lines_added() ++ ',"del":' ++ f.lines_removed() ++ '}').join(",")`,
  `']}\n'`,
].join(" ++ ")

/** A commit's ID, change ID and bookmarks, tab-separated */
const COMMIT_LINE = `commit_id ++ "\\t" ++ change_id ++ "\\t" ++ local_bookmarks.map(|b| b.name()).join(" ") ++ "\\n"`

/** jj's status names, as letters */
const letter = (status: string) => (status === "removed" ? "D" : status[0].toUpperCase())

/** The last stack jj was asked for, per page, and what it was read from */
const stacks = new Map<string, { key: string; stack: Promise<Stack> }>()

/** The stack file next to `pagePath`, filled in from the jj repo it's in.
 * jj is only asked again once the file or the repo's operations have
 * changed, since a page asks on every save of a PR's body too. */
export async function readStack(pagePath: string): Promise<Stack> {
  const dir = dirname(pagePath)
  const text = await readFile(join(dir, STACK_FILE), "utf8")
  const file = parseStackFile(text)
  // At the root, since a template's paths are relative to where jj runs
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  // The op heads dir has a file per head, named for its operation
  const key = `${(await readdir(await opHeadsDir(root))).join()}\n${text}`
  let hit = stacks.get(pagePath)
  if (hit?.key !== key) {
    const stack = readCommits(file, root, join(dir, STACK_FILE))
    hit = { key, stack }
    stacks.set(pagePath, hit)
    // A failure shouldn't stick
    stack.catch(() => stacks.delete(pagePath))
  }
  const stack = await hit.stack
  // Each title as jjack pushes it, read from the bodies each time. When jjack
  // has none, as when a body can't be read, the title key stands in so the
  // page still draws.
  const rows = stack.rows.map(async (row) => {
    if (!("n" in row)) return row
    const entry = file.prs[row.n - 1]
    const title = await entryText(entry, dir).then(
      ({ text }) => text.title,
      () => entry.title ?? "",
    )
    return { ...row, title }
  })
  return { ...stack, rows: await Promise.all(rows) }
}

/** `file`, the stack file at `path`, filled in from the repo at `root` */
async function readCommits(file: StackFile, root: string, path: string): Promise<Stack> {
  // Each entry's tip as jjack resolves it, with no call to GitHub: its
  // commit, or null for one that doesn't resolve or a merged one, the revset
  // the page has for it, and its pushed commit while that's still here
  const local = await resolveStack(await openLocalContext(root), path)
  const entries = file.prs.map((entry, i) => {
    const { commit, tipKind, pushed } = local.entries[i]
    const rev = tipKind === "bookmark" ? JSON.stringify(entry.tip) : entry.tip
    return { entry, n: i + 1, commit, rev, pushed }
  })
  // The branch jjack's PRs target, such as (main@origin)
  const trunk = `(${local.trunk})`
  /** By commit, its earlier version in what jjack last pushed for its PR:
   * itself when it's pushed, and null for a new one. Only for the commits
   * of PRs whose tips are in a line, which are all jjack pushes. */
  const earlier = new Map(
    local.entries.flatMap((e) => e.members.map((m) => [m.commit, m.pushedCommit] as const)),
  )
  const live = entries.filter((e) => e.commit !== null)
  // The PRs that have a commit, as "1 2 "
  const prsWith = live
    .map((e) => `if(self.contained_in("::${e.commit}"), "${e.n} ")`)
    .join(" ++ ")
  // Each commit above trunk that a PR has, led by the PRs that have it and
  // its bookmarks
  const log = live.length
    ? await jj(
        root,
        "log",
        "--no-graph",
        "-r",
        `::(${live.map((e) => e.commit).join(" | ")}) ~ ::${trunk}`,
        "-T",
        [
          prsWith,
          `"\\t"`,
          `local_bookmarks.map(|b| b.name()).join(" ")`,
          `"\\t"`,
          COMMIT,
        ].join(" ++ "),
      )
    : ""
  type Found = { prs: number[]; bookmarks: string; commits: Commit[] }
  // Keyed by which PRs have them, with the bookmarks on the newest
  const groups = new Map<string, Found>()
  for (const line of log.split("\n").filter(Boolean)) {
    const [prs, bookmarks, json] = line.split("\t")
    const c: Commit = JSON.parse(json)
    for (const f of c.files) f.status = letter(f.status)
    if (!groups.has(prs))
      groups.set(prs, { prs: prs.trim().split(" ").map(Number), bookmarks, commits: [] })
    groups.get(prs)!.commits.push(c)
  }
  // The group with a PR's tip's commit: of the ones the PR has, the one the
  // fewest PRs have
  const tipGroup = (n: number) =>
    [...groups.values()]
      .filter((g) => g.prs.includes(n))
      .sort((a, b) => a.prs.length - b.prs.length)[0]
  // Of the PRs on one commit, the first has its commits
  const owner = (g: Found) => live.find((e) => tipGroup(e.n) === g)

  /** A commit by a PR's tip on it, else a bookmark, else its change ID, with
   * the revset for it */
  const name = (commit: string, change: string, bookmarks: string) => {
    const pr = live.find((e) => e.commit === commit)
    if (pr) return { name: pr.entry.tip, rev: pr.rev }
    const bookmark = bookmarks.split(" ").find(Boolean)
    return bookmark
      ? { name: bookmark, rev: JSON.stringify(bookmark) }
      : { name: change, rev: change }
  }
  /** A group's base, and its diff from there to `to` */
  const measure = async (commits: Commit[], to: string) => {
    const below = `${commits.at(-1)!.commit}-`
    const [baseLine, diff] = await Promise.all([
      jj(root, "log", "--no-graph", "-r", below, "-T", COMMIT_LINE),
      jj(root, "diff", "--git", "--context", "0", "--from", below, "--to", to),
    ])
    const [commit, change, bookmarks] = baseLine.split("\n")[0].split("\t")
    const base = name(commit, change.slice(0, 8), bookmarks)
    return { base: base.name, diff: { from: base.rev, to }, files: parseGitDiff(diff) }
  }
  const changes = async (from: string, to: string): Promise<Changes> => {
    const diff = await jj(
      root,
      "interdiff",
      "--git",
      "--context",
      "0",
      "--from",
      from,
      "--to",
      to,
    )
    // interdiff has a changed description as a file of this name
    const files = parseGitDiff(diff).filter((f) => f.path !== "JJ-COMMIT-DESCRIPTION")
    return {
      add: files.reduce((n, f) => n + f.add, 0),
      del: files.reduce((n, f) => n + f.del, 0),
      reworded: diff.includes("diff --git a/JJ-COMMIT-DESCRIPTION "),
    }
  }
  /** `commits`, with a rewrite on each of `unpushed` that what jjack last
   * pushed has an earlier version of */
  const withRewrites = (commits: Commit[], unpushed: Commit[]) =>
    Promise.all(
      commits.map(async (c) => {
        const was = unpushed.includes(c) ? earlier.get(c.commit) : null
        return was ? { ...c, rewrite: { from: was, ...(await changes(was, c.commit)) } } : c
      }),
    )

  // Each row with the PRs that have its commits, which are the ones built on
  // it: none for a PR with no commits of its own
  const prs = entries.map(async (e) => {
    const { entry, n, pushed } = e
    const row: Pr = {
      n,
      tip: entry.tip,
      title: entry.title ?? "",
      body: entry.body ?? null,
      pr: entry.pr ?? null,
      merged: !!entry.merged,
      missing: !entry.merged && e.commit === null,
      pushed,
      unpushed: 0,
      head: entry.tip,
      base: "",
      diff: null,
      interdiff: null,
      files: [],
      commits: [],
    }
    if (e.commit === null) return { row, has: [] }
    const own = [...groups.values()].find((g) => owner(g) === e)
    const commits = own?.commits ?? []
    const unpushed = pushed
      ? commits.filter((c) => earlier.has(c.commit) && earlier.get(c.commit) !== c.commit)
      : []
    const [measured, rewritten] = await Promise.all([
      own && measure(own.commits, e.rev),
      unpushed.length ? withRewrites(commits, unpushed) : commits,
    ])
    Object.assign(row, measured, { commits: rewritten, unpushed: unpushed.length })
    // Its commits as pushed: the pushed commit's ancestors that aren't
    // trunk's, its base's now, or the PR below's as that was pushed. Without
    // spaces, which skepsis's arguments can't have.
    if (pushed && unpushed.length && measured) {
      const below = [trunk, measured.diff.from]
      const under = entries[n - 2]?.pushed
      if (under) below.push(under)
      const revs = {
        from: `::${pushed}~::(${below.join("|")})`,
        to: `${measured.diff.from}..${measured.diff.to}`,
      }
      // jj can't interdiff from none, as when what was pushed is all below
      // the PR now
      if (await jj(root, "log", "--no-graph", "-r", revs.from, "--limit", "1", "-T", "1"))
        row.interdiff = { ...revs, ...(await changes(revs.from, revs.to)) }
    }
    return { row, has: own?.prs ?? [] }
  })
  const shared = [...groups.values()]
    .filter((g) => !owner(g))
    .map(async (g) => {
      const top = g.commits[0]
      const row: Shared = {
        head: name(top.commit, top.change, g.bookmarks).name,
        // The ones not built on another of them
        prs: g.prs.filter(
          (n) => !g.prs.some((m) => m !== n && tipGroup(m).prs.includes(n)),
        ),
        commits: g.commits,
        ...(await measure(g.commits, top.change)),
      }
      return { row, has: g.prs }
    })
  const [prRows, sharedRows] = await Promise.all([Promise.all(prs), Promise.all(shared)])

  const graph = [...prRows, ...sharedRows].filter((r) => r.has.length)
  const heads = new Set(graph.map((r) => r.row.head))
  /** The rows `on` picks, each after the ones built on it, as Stack has them */
  const above = (on: (row: Group) => boolean): (Pr | Shared)[] =>
    graph
      .filter((r) => on(r.row))
      .sort((a, b) => Math.max(...b.has) - Math.max(...a.has))
      .flatMap((r) => [...above((row) => row.base === r.row.head), r.row])
  const outside = (missing: boolean) =>
    prRows
      .filter((r) => !r.has.length && r.row.missing === missing)
      .map((r) => r.row)
      .sort((a, b) => b.n - a.n)
  return {
    title: file.title ?? "",
    notes: file.notes ?? [],
    rows: [...outside(true), ...above((row) => !heads.has(row.base)), ...outside(false)],
  }
}

/** The body file of the stack's PR with `tip`, started with its title as a
 * heading if it isn't there yet; null if no PR in the file has that tip and
 * a markdown body */
export async function ensureBody(pagePath: string, tip: string): Promise<string | null> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const pr = file.prs.find((p) => p.tip === tip)
  if (!pr?.body?.endsWith(".md")) return null
  const path = join(dir, pr.body)
  // wx: never over one that's there
  await writeFile(path, `# ${pr.title ?? ""}\n`, { flag: "wx" }).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e
    },
  )
  return path
}

/** Each file's lines added and removed in `jj diff --git` output */
export function parseGitDiff(diff: string): FileStat[] {
  const files: FileStat[] = []
  let file: FileStat | undefined
  let inHunk = false
  for (const line of diff.split("\n")) {
    const head = line.match(/^diff --git a\/.* b\/(.*)$/)
    if (head) {
      file = { path: head[1], status: "M", add: 0, del: 0 }
      files.push(file)
      inHunk = false
    } else if (!file) continue
    else if (line.startsWith("@@")) inHunk = true
    else if (inHunk) {
      if (line[0] === "+") file.add++
      else if (line[0] === "-") file.del++
    } else if (line.startsWith("new file mode")) file.status = "A"
    else if (line.startsWith("deleted file mode")) file.status = "D"
    else if (line.startsWith("rename from")) file.status = "R"
    else if (line.startsWith("copy from")) file.status = "C"
  }
  return files
}

/** For a page with a stack file next to it, the op heads dir of the repo
 * it's in, which changes whenever its commits might have */
export async function stackOpsDir(pagePath: string): Promise<string | null> {
  const dir = dirname(pagePath)
  const root = existsSync(join(dir, STACK_FILE)) && rootFinder()(dir)
  return root ? await opHeadsDir(root).catch(() => null) : null
}
