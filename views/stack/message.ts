// A draft of the message for the commits jjack adds to update open PRs,
// which a Push button sends as `jjack submit`'s message, served at the page's
// _ah/push-message. A quick model call through the `ai` CLI writes it from
// the interdiff of each PR the push sends that changed since jjack last
// pushed it. It's kept by what it was drafted from: each such PR's pushed
// commit and its tip's commit now. The page asks for it and fills the message
// field in when it comes, so nothing waits on it. The answer is empty when no
// PR changed, on any failure, and after DRAFT_TIMEOUT. That leaves the field
// blank, so jjack picks the message: Update, or Merge … when the update is a
// merge.

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { rootFinder } from "../../core/workspace.ts"
import { sanitizeTitle } from "../../core/summary.ts"
import { jj } from "../../platform/jj.ts"
import { type Output, run } from "../../platform/proc.ts"
import { type Pr, readStack } from "./data.ts"

const DRAFT_TIMEOUT = 15_000
/** Of each PR's interdiff, which can be long */
const MAX_DIFF_CHARS = 20_000

/** Running `ai` with `input` on stdin, which tests stand in for */
export type AiRun = (args: string[], input: string) => Promise<Output>

export const aiRun: AiRun = (args, input) =>
  run("ai", args, { input, timeout: DRAFT_TIMEOUT })

const PROMPT = `Write the message for a commit that updates a pull request after review: one line in the imperative mood, under about 60 characters, saying what this update changes. No trailing period, no quotes, nothing else.

Below, for each pull request the update goes to, is its interdiff: how its changes differ from what was last pushed, apart from moving onto new parents. A file named JJ-COMMIT-DESCRIPTION is the commit descriptions.`

const drafts = new Map<string, Promise<string>>()

/** The draft for a push of the stack's PRs up to the one with `tip`, or of
 * all of them for null. Empty when none changed since jjack pushed it. */
export async function draftMessage(
  pagePath: string,
  tip: string | null,
  ai: AiRun,
): Promise<string> {
  const prs = (await readStack(pagePath)).rows
    .filter((r): r is Pr => "n" in r)
    .sort((a, b) => a.n - b.n)
  const upto = tip === null ? prs.length : (prs.find((p) => p.tip === tip)?.n ?? 0)
  const changed = prs.filter(
    (p) =>
      p.n <= upto &&
      p.pr !== null &&
      p.interdiff &&
      (p.interdiff.add || p.interdiff.del || p.interdiff.reworded),
  )
  if (!changed.length) return ""
  const key = changed.map((p) => `${p.pushed}:${p.commits[0].commit}`).join(" ")
  let draft = drafts.get(key)
  if (!draft) {
    draft = draftFrom(pagePath, changed, ai)
    drafts.set(key, draft)
  }
  const message = await draft
  // A failure isn't kept, so the next ask tries again
  if (!message) drafts.delete(key)
  return message
}

async function draftFrom(pagePath: string, prs: Pr[], ai: AiRun): Promise<string> {
  try {
    const root = rootFinder()(dirname(pagePath))!
    const diffs = await Promise.all(
      prs.map(async (p) => {
        const { from, to } = p.interdiff!
        const diff = await jj(root, "interdiff", "--git", "--from", from, "--to", to)
        return `## ${p.title || p.tip}\n\n${diff.slice(0, MAX_DIFF_CHARS)}`
      }),
    )
    // Oxide's work goes through Oxide's API keys
    const oxide = root.startsWith(join(homedir(), "oxide") + "/")
    const args = ["-m", "neon", "-q", "--raw", "--ephemeral"]
    if (oxide) args.push("--profile", "oxide")
    const out = await ai(args, [PROMPT, ...diffs].join("\n\n"))
    const line = out.success ? out.stdout.split("\n").find((l) => l.trim()) : undefined
    const message = sanitizeTitle(line ?? "")
      .replace(/^["'`“]+|["'`”]+$/g, "")
      .replace(/\.$/, "")
    return message
  } catch {
    return ""
  }
}
