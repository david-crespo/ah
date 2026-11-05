// A stack page's data, which stack.ts draws: the PRs an agent lists in
// stack.json next to the page, filled in from jj. The agent writes only what
// jj doesn't know (titles, notes, how each PR merges, summaries). The rest
// comes from the graph: a PR is its bookmark's commits down to the nearest
// other PR's bookmark or trunk, and that is its base.

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
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
  files: FileStat[]
  commits: Commit[]
}

/** PRs newest first */
export interface Stack {
  title: string
  notes: string[]
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
  const prs = await Promise.all(
    file.prs.map(async (pr): Promise<Pr> => {
      const tip = JSON.stringify(pr.bookmark)
      // Trunk and the other PRs this one is on top of
      const others = file.prs.filter((q) => q !== pr).map((q) => symbol(q.bookmark))
      const below = `(trunk() | ((${["none()", ...others].join(" | ")}) & ::(${tip}-)))`
      const base = `heads(::${below} & ::${tip})`
      const [commits, baseLine, diff] = await Promise.all([
        jj("log", "--no-graph", "-r", `${below}..${tip}`, "-T", COMMIT),
        jj("log", "--no-graph", "-r", base, "-T", BASE),
        jj("diff", "--git", "--context", "0", "--from", base, "--to", tip),
      ])
      const [change, bookmarks = ""] = baseLine.split("\n")[0].split("\t")
      const names = bookmarks.split(" ").filter(Boolean)
      return {
        ...pr,
        base:
          file.prs.find((q) => names.includes(q.bookmark))?.bookmark ?? names[0] ?? change,
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
    }),
  )
  return {
    title: file.title,
    notes: file.notes ?? [],
    prs: prs.sort((a, b) => b.n - a.n),
  }
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
