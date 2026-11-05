// A stack page's data, which stack.ts draws: the PRs an agent lists in
// stack.json next to the page, filled in from jj. The agent writes only what
// jj doesn't know (titles, notes, how each PR merges, summaries). The rest
// comes from the graph: a PR is its bookmark's commits that trunk and the PRs
// before it (lower n) don't have, and its base is where it forks from them.

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { opHeadsDir } from "../../platform/jj.ts"
import { isRecord } from "../../platform/guards.ts"
import { run } from "../../platform/proc.ts"

export const STACK_FILE = "stack.json"

/** A PR as stack.json has it */
export interface StackPr {
  n: number
  title: string
  bookmark: string
  /** How it merges, like "merges alone, first" */
  merge?: string
  summary?: string
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
}

/** `base` is the PR's parent PR's bookmark, or the commit it forks from
 * trunk at. Commits are newest first. */
export interface Pr extends StackPr {
  base: string
  /** Set when the base is inside an earlier PR's commits, not at its tip */
  forksFrom: { n: number; change: string } | null
  /** The bookmark's commit on its remote as of the last fetch, if it's been pushed */
  pushed: string | null
  files: FileStat[]
  commits: Commit[]
}

/** PRs newest first. `trunk` is the branch the bottom PR merges into on
 * GitHub, like main: trunk()'s remote bookmark, or empty without one. */
export interface Stack {
  title: string
  notes: string[]
  trunk: string
  prs: Pr[]
}

export function parseStackFile(text: string): StackFile {
  const file: unknown = JSON.parse(text)
  const isPr = (pr: unknown) =>
    isRecord(pr) &&
    typeof pr.n === "number" &&
    typeof pr.title === "string" &&
    typeof pr.bookmark === "string"
  if (!isRecord(file) || typeof file.title !== "string" || !Array.isArray(file.prs))
    throw new Error(`${STACK_FILE} needs a title and a list of prs`)
  if (!file.prs.every(isPr))
    throw new Error(`each PR in ${STACK_FILE} needs n, title and bookmark`)
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

/** The stack.json next to `pagePath`, filled in from the jj repo it's in */
export async function readStack(pagePath: string): Promise<Stack> {
  const dir = dirname(pagePath)
  const file = parseStackFile(await readFile(join(dir, STACK_FILE), "utf8"))
  // At the root, since a template's paths are relative to where jj runs
  const root = rootFinder()(dir)
  if (!root) throw new Error(`${dir} isn't in a jj workspace`)
  const jj = async (...args: string[]) => {
    const { success, stdout, stderr } = await run(
      "jj",
      ["--ignore-working-copy", "--color=never", ...args],
      { cwd: root },
    )
    if (!success) throw new Error(stderr.trim())
    return stdout
  }
  // A string literal is a symbol in a revset; present() allows a PR whose
  // bookmark doesn't exist yet
  const symbol = (bookmark: string) => `present(${JSON.stringify(bookmark)})`
  const trunk = jj(
    "log",
    "--no-graph",
    "-r",
    "trunk()",
    "-T",
    `remote_bookmarks.filter(|b| b.remote() != "git").map(|b| b.name()).join(" ")`,
  )
  const prs = await Promise.all(
    file.prs.map(async (pr) => {
      const tip = JSON.stringify(pr.bookmark)
      // Trunk and the PRs before this one
      const earlier = file.prs.filter((q) => q.n < pr.n).map((q) => symbol(q.bookmark))
      const below = `(${["trunk()", ...earlier].join(" | ")})`
      const base = `heads(::${below} & ::${tip})`
      // On a commit, a remote bookmark of this name, other than git's
      const onRemote = `remote_bookmarks.filter(|b| b.remote() != "git" && b.name() == ${tip}).len() > 0`
      const [commits, baseLine, pushed, diff, title] = await Promise.all([
        jj("log", "--no-graph", "-r", `::${tip} ~ ::${below}`, "-T", COMMIT),
        jj("log", "--no-graph", "-r", base, "-T", BASE),
        jj(
          "log",
          "--no-graph",
          "-r",
          `remote_bookmarks(exact:${tip})`,
          "-T",
          `if(${onRemote}, commit_id.short(8) ++ "\n")`,
        ),
        jj("diff", "--git", "--context", "0", "--from", base, "--to", tip),
        bodyTitle(pagePath, pr.bookmark),
      ])
      const [change, bookmarks = ""] = baseLine.split("\n")[0].split("\t")
      const names = bookmarks.split(" ").filter(Boolean)
      const result: Pr = {
        ...pr,
        title: title ?? pr.title,
        forksFrom: null,
        base:
          file.prs.find((q) => names.includes(q.bookmark))?.bookmark ?? names[0] ?? change,
        pushed: pushed.split("\n")[0] || null,
        files: parseGitDiff(diff),
        commits: commits
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const c: Commit = JSON.parse(line)
            for (const f of c.files) f.status = letter(f.status)
            return c
          }),
      }
      return [result, change] as const
    }),
  )
  // A base that's in an earlier PR but isn't its tip: the PR forks mid-way
  for (const [pr, change] of prs) {
    for (const [q] of prs) {
      if (q.n < pr.n && q.commits.slice(1).some((c) => c.change === change))
        pr.forksFrom = { n: q.n, change }
    }
  }
  return {
    title: file.title,
    notes: file.notes ?? [],
    trunk: (await trunk).trim().split(" ")[0],
    prs: prs.map(([pr]) => pr).sort((a, b) => b.n - a.n),
  }
}

/** A PR's body, the markdown its GitHub description is drafted in: next to
 * the page, named for its bookmark. Null for a bookmark that can't be a
 * file name there. */
export function bodyPath(pagePath: string, bookmark: string): string | null {
  return /^[\w-][\w.-]*$/.test(bookmark) ? join(dirname(pagePath), `${bookmark}.md`) : null
}

/** The title a PR's body gives it, as a heading on its first line. It wins
 * over stack.json's, since the body is what goes on GitHub. */
async function bodyTitle(pagePath: string, bookmark: string): Promise<string | null> {
  const path = bodyPath(pagePath, bookmark)
  const text = path && (await readFile(path, "utf8").catch(() => null))
  return text?.match(/^# (.+)/)?.[1].trim() || null
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
