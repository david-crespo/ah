// The jj side of the preview's diff mode (preview.ts): a file as it was at a
// revision, and the revisions worth diffing it from. Reads only, without
// snapshotting the working copy: a read shouldn't take its lock, and the
// bases are commits anyway.

import { execFile } from "node:child_process"
import { basename, dirname } from "node:path"
import { promisify } from "node:util"

/** What the diff mode diffs from when given no revision: the working copy's
 * parent, so it shows the changes in the working copy */
export const DEFAULT_BASE = "@-"

const TRUNK = "trunk()"

/** A commit, as the picker and the bar show it */
export type Revision = {
  change: string
  commit: string
  ago: string
  bookmarks: string
  description: string
  /** Lines this commit added to and removed from the file */
  added: number
  removed: number
  /** Whether it's on trunk, and whether it's the working copy */
  onTrunk: boolean
  workingCopy: boolean
}

function jj(path: string, ...args: string[]) {
  return promisify(execFile)("jj", ["--ignore-working-copy", "--color=never", ...args], {
    cwd: dirname(path),
  })
}

/** A fileset that's just this file, whatever its name */
const fileset = (path: string) => `file:${JSON.stringify(basename(path))}`

/** The commits in `revset`, newest first, at most `limit` */
async function revisions(path: string, revset: string, limit: number): Promise<Revision[]> {
  const stat = `self.diff(${JSON.stringify(fileset(path))}).stat()`
  const fields = [
    "change_id.short()",
    "commit_id.short()",
    "author.timestamp().ago()",
    'local_bookmarks.map(|b| b.name()).join(" ")',
    "description.first_line()",
    `${stat}.total_added()`,
    `${stat}.total_removed()`,
    `self.contained_in(${JSON.stringify(`::${TRUNK}`)})`,
    "current_working_copy",
  ]
  const template = `${fields.join(' ++ "\\t" ++ ')} ++ "\\n"`
  const { stdout } = await jj(
    path,
    "log",
    "--no-graph",
    "-n",
    String(limit),
    "-r",
    revset,
    "-T",
    template,
  )
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [change, commit, ago, bookmarks, description, added, removed, onTrunk, wc] =
        line.split("\t")
      return {
        change,
        commit,
        ago,
        bookmarks,
        description,
        added: Number(added),
        removed: Number(removed),
        onTrunk: onTrunk === "true",
        workingCopy: wc === "true",
      }
    })
}

/** How a commit reads in a sentence: its bookmarks, else its description */
const label = (r: Revision) =>
  r.bookmarks || r.description || (r.workingCopy ? "the working copy" : r.change)

/** The file at `rev`, a revset for one commit, that commit, and how the bar
 * says what the diff covers: changes `relation` `label`. A file that wasn't there is empty. Throws jj's
 * complaint about the revset. */
export async function fileAt(path: string, rev: string) {
  rev ||= DEFAULT_BASE
  const found = await revisions(path, rev, 2)
  if (found.length !== 1)
    throw new Error(`${rev} is ${found.length ? "more than one commit" : "no commits"}`)
  const [commit] = found
  const text = await jj(path, "file", "show", "-r", commit.commit, fileset(path)).then(
    (r) => r.stdout,
    (e: { stderr?: string }) => {
      if (e.stderr?.includes("No such path")) return ""
      throw e
    },
  )
  // From the parent of X, as the picker's rows pick, the diff is X's change
  // and what came after it
  const [from] = rev.endsWith("-")
    ? await revisions(path, rev.slice(0, -1), 2).catch(() => [])
    : []
  return {
    rev,
    commit: commit.commit,
    relation: from ? "starting with" : "since",
    label: label(from ?? commit),
    text,
  }
}

/** The picker's list (base_picker.ts): the last 20 revisions that changed
 * the file, newest first, with the working copy, trunk's commit and the
 * base shown, `rev`, where they fall, and trunk's commit */
export async function bases(path: string, rev: string) {
  const changed = `::@ & (files(${fileset(path)}) | ${TRUNK} | @)`
  // The base's commit, as a picked row's `X-` or a revset typed in
  const shown = (rev || DEFAULT_BASE).replace(/-$/, "")
  const [history, trunk] = await Promise.all([
    revisions(path, `${changed} | ::@ & (${shown})`, 20).catch(() =>
      revisions(path, changed, 20),
    ),
    revisions(path, TRUNK, 1).catch(() => []),
  ])
  return { history, trunk: trunk[0] ?? null }
}

/** jj's complaint from a failed call, or the error */
export const complaint = (e: unknown) =>
  (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e))
