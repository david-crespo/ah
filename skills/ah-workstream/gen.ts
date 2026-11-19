// Writes data.json for a workstream page (index.html): the work.json next to
// it, with each item's revs from jj, newest first, with their diff stats, and
// the titles of its notes and PR drafts from their files. Also writes
// workspaces.json, which lists the items' workspaces, so ah lets the page
// open diffs in those of other repos. Run it as `node gen.ts [dir]`, where
// dir is the page's directory, by default this file's.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

const dir = resolve(process.argv[2] ?? import.meta.dirname)
/** The page's directory is directly in .claude/notes. The paths of notes
 * and PR drafts are relative to .claude/notes, which is how the page's Open
 * buttons send them to ah. */
const notesDir = dirname(dir)

type Item = {
  title: string
  workspace?: string
  revset?: string
  notes?: string[]
  prs?: string[]
}
type Work = { groups: { items: Item[] }[] }

/** One JSON array per rev: change ID, description, lines added and removed,
 * whether it's some workspace's working copy, and per file, its path and
 * lines added and removed */
const REV_TEMPLATE = `"[" ++ ${[
  "json(change_id.short(8))",
  "json(description)",
  "self.diff().stat().total_added()",
  "self.diff().stat().total_removed()",
  'json(self.contained_in("working_copies()"))',
  `"[" ++ self.diff().stat().files().map(|f| "[" ++ json(f.display_diff_path()) ++ "," ++ f.lines_added() ++ "," ++ f.lines_removed() ++ "]").join(",") ++ "]"`,
].join(' ++ "," ++ ')} ++ "]\\n"`

/** The revs in `revset`, newest first, as jj in `workspace` resolves it.
 * Throws jj's complaint. */
function revs(workspace: string, revset: string) {
  const args = ["--color=never", "log", "--no-graph", "-r", revset, "-T", REV_TEMPLATE]
  let out: string
  try {
    out = execFileSync("jj", args, { cwd: workspace, encoding: "utf8", stdio: "pipe" })
  } catch (e) {
    throw new Error(String((e as { stderr?: string }).stderr || e).trim())
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [change, description, added, removed, workingCopy, files] = JSON.parse(line)
      const [title, ...body] = description.trim().split("\n")
      return {
        change,
        title,
        body: body.join("\n").trim(),
        added,
        removed,
        workingCopy,
        files: files.map(([path, added, removed]: [string, number, number]) => ({
          path,
          added,
          removed,
        })),
      }
    })
}

/** The title of the note or PR draft at `file`: the text of a Markdown or
 * AsciiDoc heading on its first line, or an HTML page's <title>, without a
 * leading date; `file` if it has neither; null if there's no such file */
function title(file: string): string | null {
  const path = join(notesDir, file)
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8")
  const heading = text.match(/^[#=] (.+)/)?.[1] ?? text.match(/<title>(.+?)<\/title>/)?.[1]
  return heading?.replace(/^\d{4}-\d{2}-\d{2} /, "") ?? file
}

function expand(item: Item) {
  const prs = (item.prs ?? []).map((slug) => {
    const file = `${basename(dir)}/pr/${slug}.md`
    return { slug, file, title: title(file) }
  })
  const notes = (item.notes ?? []).map((file) => ({ file, title: title(file) ?? file }))
  let commits: ReturnType<typeof revs> = []
  let error: string | undefined
  try {
    if (item.workspace && item.revset) commits = revs(item.workspace, item.revset)
  } catch (e) {
    error = (e as Error).message
  }
  return { ...item, prs, notes, commits, error }
}

const work: Work = JSON.parse(readFileSync(join(dir, "work.json"), "utf8"))
const groups = work.groups.map((g) => ({ ...g, items: g.items.map(expand) }))
const data = { ...work, generated: new Date().toISOString(), groups }
writeFileSync(join(dir, "data.json"), JSON.stringify(data, null, 1) + "\n")

// ah lets a page open diffs and notes in workspaces of its own repo and in
// the ones its workspaces.json lists
const items = groups.flatMap((g) => g.items)
const workspaces = [...new Set(items.flatMap((i) => i.workspace ?? []))].sort()
writeFileSync(join(dir, "workspaces.json"), JSON.stringify({ workspaces }, null, 1) + "\n")

console.log(`${items.reduce((n, i) => n + i.commits.length, 0)} revs`)
for (const i of items) if (i.error) console.log(`${i.title}: ${i.error}`)
