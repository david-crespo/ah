// Checks on how ah is set up in the agent harnesses, for `ah doctor` and the
// dashboard's warning: the skills each harness has of ah's, and Claude Code's
// hooks. They're the
// user's config, so this says what's wrong and how to fix it, and changes
// nothing. What an upgrade leaves wrong (a link that dangles, a copy that's
// out of date, a missing hook) is a problem; a skill a harness never had is
// only listed. Claude Code takes skills as links; Codex, opencode and pi need
// copies, since their scanners skip links.

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { HOOK_EVENTS } from "../model.ts"
import { assetPath } from "./assets.ts"
import { isRecord, isString } from "./guards.ts"
import { claudeConfigDirs, plainlyUnder, readdirOrEmpty } from "./paths.ts"

/** Skills ah shipped under other names, by the old name */
const RENAMED_SKILLS: Record<string, string> = {
  html: "ah-page",
  markdown: "ah-doc",
  panes: "ah-panes",
  skepsis: "ah-skepsis",
  tracker: "ah-tracker",
}

/** ah's hook for Claude Code: with no --harness, or with claude's */
const runsAh = (command: string) =>
  /\bah(\.ts)? hook agent\b/.test(command) && !/--harness (?!claude\b)/.test(command)

/** The commands Claude Code's settings at `path` run on `event` */
function hookCommands(path: string, event: string): string[] {
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return []
  }
  const groups =
    isRecord(settings) && isRecord(settings.hooks) ? settings.hooks[event] : null
  if (!Array.isArray(groups)) return []
  return groups
    .flatMap((g) => (isRecord(g) && Array.isArray(g.hooks) ? g.hooks : []))
    .flatMap((h) => (isRecord(h) && isString(h.command) ? [h.command] : []))
}

export interface Problem {
  problem: string
  fix: string
  /** A skill the harness doesn't have, which may be on purpose: listed by
   * `ah doctor`, and left out of the dashboard's warning */
  optional?: true
}

/** The skills directories of the harnesses on this machine */
function harnessSkillDirs(): string[] {
  const home = homedir()
  return [
    ...claudeConfigDirs().map((d) => join(d, "skills")),
    join(home, ".codex", "skills"),
    join(home, ".config", "opencode", "skills"),
    join(home, ".pi", "agent", "skills"),
  ].filter((d) => existsSync(d))
}

const skillText = (dir: string) => {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf8")
  } catch {
    return null
  }
}

/** Whether the skill at `dir` is one of ah's, by its instructions using ah */
const usesAh = (dir: string) =>
  /\bah (tool|view|app|message|window|server)\b/.test(skillText(dir) ?? "")

/** What's wrong with ah's skills in each of `dirs`, a harness's skills
 * directory, and with the hooks of each Claude config dir that has them.
 * A harness with none of ah's skills is one the user doesn't use ah with,
 * and is left alone. */
export function installProblems(
  dirs = harnessSkillDirs(),
  skills = assetPath("skills"),
  claudeDirs = claudeConfigDirs(),
): Problem[] {
  const shipped = readdirOrEmpty(skills).filter((s) =>
    existsSync(join(skills, s, "SKILL.md")),
  )
  const problems: Problem[] = []
  const withAh = new Set<string>()
  for (const dir of dirs) {
    let links = false
    let copies = false
    /** Skills a fix above already adds */
    const added = new Set<string>()
    for (const name of readdirOrEmpty(dir)) {
      const path = join(dir, name)
      const renamed = RENAMED_SKILLS[name]
      if (lstatSync(path).isSymbolicLink()) {
        const target = resolve(dir, readlinkSync(path))
        if (target !== skills && !plainlyUnder(skills, target)) continue
        links = true
        if (existsSync(target)) continue
        if (renamed) added.add(renamed)
        problems.push({
          problem: `${path} links to ${target}, which is gone${renamed ? `: the skill is ${renamed} now` : ""}`,
          fix: renamed
            ? `ln -sfn ${join(skills, renamed)} ${join(dir, renamed)} && rm ${path}`
            : `rm ${path}`,
        })
      } else if (shipped.includes(name)) {
        copies = true
        // A copy doesn't follow the checkout as a link does
        if (skillText(path) !== skillText(join(skills, name)))
          problems.push({
            problem: `${path} is a copy of ah's ${name} skill that differs from the current one`,
            fix: `rm -r ${path} && cp -R ${join(skills, name)} ${dir}/`,
          })
      } else if (renamed && usesAh(path)) {
        copies = true
        added.add(renamed)
        problems.push({
          problem: `${path} is a copy of ah's ${name} skill, which is ${renamed} now`,
          fix: `rm -r ${path} && cp -R ${join(skills, renamed)} ${dir}/`,
        })
      }
    }
    if (!links && !copies) continue
    withAh.add(dir)
    for (const skill of shipped) {
      if (added.has(skill) || existsSync(join(dir, skill))) continue
      problems.push({
        optional: true,
        problem: `${dir} doesn't have ah's ${skill} skill`,
        fix: links
          ? `ln -s ${join(skills, skill)} ${dir}/`
          : `cp -R ${join(skills, skill)} ${dir}/`,
      })
    }
  }
  for (const config of claudeDirs) {
    if (!withAh.has(join(config, "skills"))) continue
    const settings = join(config, "settings.json")
    const missing = HOOK_EVENTS.filter((e) => !hookCommands(settings, e).some(runsAh))
    if (missing.length)
      problems.push({
        problem: `${settings} doesn't run \`ah hook agent\` on ${missing.join(", ")}`,
        fix: `add the hooks in ${assetPath("docs/setup.md")} (Hooks)`,
      })
  }
  return problems
}
