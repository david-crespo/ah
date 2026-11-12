// A stack page's data, which client.ts draws: the PRs an agent lists in
// stack.json next to the page, filled in from jj. The agent writes only what
// jj doesn't know (titles, notes, how each PR merges). The rest
// comes from the graph. Commits above trunk are grouped by which PRs'
// bookmarks have them. A PR's own are the ones its bookmark's commit is
// grouped with: no PR below it has them. Any other group is commits below a
// fork that no PR's bookmark is on, which the PRs above share.

import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { jj, opHeadsDir } from "../../platform/jj.ts"
import { isRecord } from "../../platform/guards.ts"

export const STACK_FILE = "stack.json"

/** A PR as stack.json has it */
export interface StackPr {
  n: number
  title: string
  bookmark: string
  /** How it merges, like "merges alone, first" */
  merge?: string
}

export interface StackFile {
  title: string
  notes?: string[]
  prs: StackPr[]
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
  /** On a PR's commit still to push, when its remote bookmark has an earlier
   * version of it: what changed since */
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
  /** The earlier version's commit ID, on the remote bookmark */
  from: string
}

/** Commits drawn as one card, newest first. `head` is its newest commit and
 * `base` the commit below its oldest, each by a PR's bookmark on it, else
 * another bookmark, else its change ID. */
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
export interface Pr extends StackPr, Group {
  /** Its bookmark doesn't exist yet, so it has no commits */
  missing: boolean
  /** The bookmark's commit on its remote as of the last fetch, if it's been pushed */
  pushed: string | null
  /** That commit isn't one of its ancestors, as after a rebase or an edit, so
   * a push rewrites what's pushed */
  rewrites: boolean
  /** How many of its commits its remote bookmark doesn't have: all of them
   * before it's pushed. A pushed commit's ancestors are pushed too, so
   * they're the newest ones. */
  unpushed: number
  /** Once pushed, with commits still to push: revsets for its commits on
   * the remote and its commits now, for jj interdiff, and what that shows */
  interdiff: (Changes & { from: string; to: string }) | null
}

/** Commits below a fork that no PR's bookmark is on */
export interface Shared extends Group {
  /** The lowest PRs that have them, so each would include them on GitHub */
  prs: number[]
}

/** `rows` are the PRs and shared groups newest first, like jj log: each
 * below the ones built on it, and of the ones built on the same one, the
 * one leading to the highest PR first. PRs whose bookmark doesn't exist yet
 * come first and PRs with no commits of their own, like merged ones, last.
 * `trunk` is the branch the bottom PR merges into on GitHub, like main:
 * trunk()'s remote bookmark, or empty without one. */
export interface Stack {
  title: string
  notes: string[]
  trunk: string
  rows: (Pr | Shared)[]
}

export function parseStackFile(text: string): StackFile {
  const file: unknown = JSON.parse(text)
  const isPr = (pr: unknown) =>
    isRecord(pr) &&
    typeof pr.n === "number" &&
    typeof pr.title === "string" &&
    typeof pr.bookmark === "string"
  const optional = (v: unknown) => v === undefined || typeof v === "string"
  if (!isRecord(file) || typeof file.title !== "string" || !Array.isArray(file.prs))
    throw new Error(`${STACK_FILE} needs a title and a list of prs`)
  if (
    file.notes !== undefined &&
    !(Array.isArray(file.notes) && file.notes.every((n) => typeof n === "string"))
  )
    throw new Error(`notes in ${STACK_FILE} must be a list of strings`)
  if (!file.prs.every(isPr))
    throw new Error(`each PR in ${STACK_FILE} needs n, title and bookmark`)
  if (!file.prs.every((pr) => optional(pr.merge)))
    throw new Error(`a PR's merge in ${STACK_FILE} must be a string`)
  return file as unknown as StackFile
}

// One JSON object per commit, with each file's line counts
const COMMIT = [
  `'{"change":' ++ json(change_id.short(8))`,
  `',"short":' ++ json(stringify(change_id.shortest(4)))`,
  `',"commit":' ++ json(commit_id.short(8))`,
  `',"description":' ++ json(description)`,
  `',"files":[' ++ self.diff().stat().files().map(|f| '{"path":' ++ json(f.path().display()) ++ ',"status":' ++ json(f.status()) ++ ',"add":' ++ f.lines_added() ++ ',"del":' ++ f.lines_removed() ++ '}').join(",")`,
  `']}\n'`,
].join(" ++ ")

const BASE = `change_id.short(8) ++ "\\t" ++ local_bookmarks.map(|b| b.name()).join(" ") ++ "\\n"`

/** jj's status names, as letters */
const letter = (status: string) => (status === "removed" ? "D" : status[0].toUpperCase())

/** The last stack jj was asked for, per page, and what it was read from */
const stacks = new Map<string, { key: string; stack: Promise<Stack> }>()

/** The stack.json next to `pagePath`, filled in from the jj repo it's in.
 * jj is only asked again once stack.json or the repo's operations have
 * changed, since a page asks on every save of a PR's body too. */
/** A pushed PR's revsets for jj interdiff: its commits on the remote, which
 * are its remote bookmark's ancestors that aren't trunk's or its base's,
 * here or on the remote, against its commits here. `tip` and the diff's
 * revsets are as `measure` quotes them. Without spaces, which skepsis's
 * arguments can't have. */
export function interdiff(
  tip: string,
  { base, diff }: { base: string; diff: { from: string; to: string } },
): { from: string; to: string } {
  // The base by a bookmark, which its revset quotes, has a remote version
  const below = ["trunk()", diff.from]
  if (diff.from !== base) below.push(`remote_bookmarks(exact:${diff.from})`)
  return {
    from: `::remote_bookmarks(exact:${tip})~::(${below.join("|")})`,
    to: `${diff.from}..${diff.to}`,
  }
}

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
    const stack = readCommits(file, root)
    hit = { key, stack }
    stacks.set(pagePath, hit)
    // A failure shouldn't stick
    stack.catch(() => stacks.delete(pagePath))
  }
  const stack = await hit.stack
  // A body's title wins over stack.json's, since the body is what goes on
  // GitHub
  const rows = stack.rows.map(async (row) =>
    "bookmark" in row ? { ...row, title: (await prText(pagePath, row)).title } : row,
  )
  return { ...stack, rows: await Promise.all(rows) }
}

async function readCommits(file: StackFile, root: string): Promise<Stack> {
  // Awaited together: one that fails while the other is awaited would be an
  // unhandled rejection, which ends the server
  const [trunk, existing] = await Promise.all([
    jj(
      root,
      "log",
      "--no-graph",
      "-r",
      "trunk()",
      "-T",
      `remote_bookmarks.filter(|b| b.remote() != "git").map(|b| b.name()).join(" ")`,
    ),
    jj(root, "bookmark", "list", "-T", `name ++ "\n"`).then((out) => out.split("\n")),
  ])
  const live = file.prs.filter((pr) => existing.includes(pr.bookmark))
  const tips = live.map((pr) => JSON.stringify(pr.bookmark))
  // The PRs for which a commit is in ::revset(tip), as "1 2 "
  const prsWith = (revset: (tip: string) => string) =>
    live
      .map(
        (pr, i) => `if(self.contained_in(${JSON.stringify(revset(tips[i]))}), "${pr.n} ")`,
      )
      .join(" ++ ")
  // Each commit above trunk that a PR has, led by the PRs that have it, the
  // PRs whose remote bookmark has it, and its bookmarks
  const log = live.length
    ? await jj(
        root,
        "log",
        "--no-graph",
        "-r",
        `::(${tips.join(" | ")}) ~ ::trunk()`,
        "-T",
        [
          prsWith((tip) => `::${tip}`),
          `"\\t"`,
          prsWith((tip) => `::remote_bookmarks(exact:${tip})`),
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
  /** By commit ID, the PRs whose remote bookmark has it */
  const pushedIn = new Map<string, string[]>()
  for (const line of log.split("\n").filter(Boolean)) {
    const [prs, remotes, bookmarks, json] = line.split("\t")
    const c: Commit = JSON.parse(json)
    for (const f of c.files) f.status = letter(f.status)
    pushedIn.set(c.commit, remotes.split(" "))
    if (!groups.has(prs))
      groups.set(prs, { prs: prs.trim().split(" ").map(Number), bookmarks, commits: [] })
    groups.get(prs)!.commits.push(c)
  }
  // The group with a PR's bookmark's commit: of the ones the PR has, the one
  // the fewest PRs have
  const tipGroup = (n: number) =>
    [...groups.values()]
      .filter((g) => g.prs.includes(n))
      .sort((a, b) => a.prs.length - b.prs.length)[0]
  // Of the PRs on one commit, the first has its commits
  const owner = (g: Found) => live.find((pr) => tipGroup(pr.n) === g)

  // A commit by a PR's bookmark on it, else another bookmark, else its change ID
  const name = (change: string, bookmarks: string) => {
    const names = bookmarks.split(" ").filter(Boolean)
    return file.prs.find((q) => names.includes(q.bookmark))?.bookmark ?? names[0] ?? change
  }
  /** A group's base, and its diff from there to `to` */
  const measure = async (commits: Commit[], to: string) => {
    const below = `${commits.at(-1)!.commit}-`
    const [baseLine, diff] = await Promise.all([
      jj(root, "log", "--no-graph", "-r", below, "-T", BASE),
      jj(root, "diff", "--git", "--context", "0", "--from", below, "--to", to),
    ])
    const [change, bookmarks = ""] = baseLine.split("\n")[0].split("\t")
    const base = name(change, bookmarks)
    const from = base === change ? change : JSON.stringify(base)
    return { base, diff: { from, to }, files: parseGitDiff(diff) }
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
  /** `commits`, with a rewrite on each of `unpushed` that the remote
   * bookmark `tip` has an earlier version of, found by its change ID */
  const withRewrites = async (tip: string, commits: Commit[], unpushed: Commit[]) => {
    if (!unpushed.length) return commits
    const remote = await jj(
      root,
      "log",
      "--no-graph",
      "-r",
      `::remote_bookmarks(exact:${tip}) ~ ::trunk()`,
      "-T",
      `change_id.short(8) ++ " " ++ commit_id ++ "\\n"`,
    )
    const earlier = new Map(
      remote
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    )
    const rewrite = async (c: Commit): Promise<Rewrite | undefined> => {
      const was = earlier.get(c.change)
      return was ? { from: was, ...(await changes(was, c.commit)) } : undefined
    }
    return Promise.all(
      commits.map(async (c) => {
        const r = unpushed.includes(c) ? await rewrite(c) : undefined
        return r ? { ...c, rewrite: r } : c
      }),
    )
  }

  // Each row with the PRs that have its commits, which are the ones built on
  // it: none for a PR with no commits of its own
  const prs = file.prs.map(async (pr) => {
    const none = {
      head: pr.bookmark,
      base: "",
      diff: null,
      interdiff: null,
      files: [],
      commits: [],
    }
    // Listed before its bookmark exists
    if (!existing.includes(pr.bookmark)) {
      const row: Pr = {
        ...pr,
        ...none,
        missing: true,
        pushed: null,
        rewrites: false,
        unpushed: 0,
      }
      return { row, has: [] }
    }
    const tip = JSON.stringify(pr.bookmark)
    const own = [...groups.values()].find((g) => owner(g) === pr)
    // On a commit, a remote bookmark of this name, other than git's
    const onRemote = `remote_bookmarks.filter(|b| b.remote() != "git" && b.name() == ${tip}).len() > 0`
    const commits = own?.commits ?? []
    const unpushed = commits.filter((c) => !pushedIn.get(c.commit)!.includes(String(pr.n)))
    const [pushed, measured, rewritten] = await Promise.all([
      jj(
        root,
        "log",
        "--no-graph",
        "-r",
        `remote_bookmarks(exact:${tip})`,
        "-T",
        `if(${onRemote}, commit_id.short(8) ++ if(self.contained_in(${JSON.stringify(`::${tip}`)}), "", " rewrites") ++ "\n")`,
      ),
      own && measure(own.commits, tip),
      withRewrites(tip, commits, unpushed),
    ])
    const [pushedAt, rewrites] = pushed.split("\n")[0].split(" ")
    const row: Pr = {
      ...pr,
      ...none,
      ...measured,
      commits: rewritten,
      missing: false,
      pushed: pushedAt || null,
      rewrites: !!rewrites,
      unpushed: unpushed.length,
    }
    // jj can't interdiff from none, as when what the remote has is all
    // below the PR now
    const revs = row.pushed && row.unpushed && measured && interdiff(tip, measured)
    if (
      revs &&
      (await jj(root, "log", "--no-graph", "-r", revs.from, "--limit", "1", "-T", "1"))
    )
      row.interdiff = { ...revs, ...(await changes(revs.from, revs.to)) }
    return { row, has: own?.prs ?? [] }
  })
  const shared = [...groups.values()]
    .filter((g) => !owner(g))
    .map(async (g) => {
      const top = g.commits[0].change
      const row: Shared = {
        head: name(top, g.bookmarks),
        // The ones not built on another of them
        prs: g.prs.filter(
          (n) => !g.prs.some((m) => m !== n && tipGroup(m).prs.includes(n)),
        ),
        commits: g.commits,
        ...(await measure(g.commits, top)),
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
    title: file.title,
    notes: file.notes ?? [],
    trunk: trunk.trim().split(" ")[0],
    rows: [...outside(true), ...above((row) => !heads.has(row.base)), ...outside(false)],
  }
}

/** A PR's body, the markdown its GitHub description is drafted in: next to
 * the page, named for its bookmark, each / as --. Null for a bookmark that
 * can't be a file name there. */
export function bodyPath(pagePath: string, bookmark: string): string | null {
  const name = bookmark.replaceAll("/", "--")
  return /^[\w-][\w.-]*$/.test(name) ? join(dirname(pagePath), `${name}.md`) : null
}

/** A PR's title and description for GitHub, from its body: the heading on
 * its first line, else its title in stack.json, and the rest of the file,
 * empty without one */
export async function prText(
  pagePath: string,
  pr: Pick<StackPr, "bookmark" | "title">,
): Promise<{ title: string; body: string }> {
  const path = bodyPath(pagePath, pr.bookmark)
  const text = (path && (await readFile(path, "utf8").catch(() => null))) || ""
  const heading = text.match(/^# (.*)(?:\n|$)/)
  const title = heading?.[1].trim() || pr.title
  return { title, body: text.slice(heading?.[0].length ?? 0).trim() }
}

/** The body of the stack's PR with `bookmark`, started with its title as a
 * heading if there isn't one yet; null if no PR in stack.json has it */
export async function ensureBody(
  pagePath: string,
  bookmark: string,
): Promise<string | null> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  const pr = file.prs.find((p) => p.bookmark === bookmark)
  const path = pr && bodyPath(pagePath, bookmark)
  if (!path) return null
  // wx: never over one that's there
  await writeFile(path, `# ${pr.title}\n`, { flag: "wx" }).catch(
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

/** For a page with a stack.json next to it, the op heads dir of the repo
 * it's in, which changes whenever its commits might have */
export async function stackOpsDir(pagePath: string): Promise<string | null> {
  const dir = dirname(pagePath)
  const root = existsSync(join(dir, STACK_FILE)) && rootFinder()(dir)
  return root ? await opHeadsDir(root).catch(() => null) : null
}
