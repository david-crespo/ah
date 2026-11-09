import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { installProblems } from "./install_check.ts"

let dir: string
let skills: string
const skill = (at: string, text = "Run `ah tool page`") => {
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, "SKILL.md"), text)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-install-"))
  skills = join(dir, "ah", "skills")
  for (const name of ["ah-page", "ah-doc"]) skill(join(skills, name))
})

test("a dangling link to a renamed skill, and a missing one", () => {
  const claude = join(dir, "claude", "skills")
  mkdirSync(claude, { recursive: true })
  symlinkSync(join(skills, "html"), join(claude, "html"))
  expect(installProblems([claude], skills, [])).toEqual([
    {
      problem: `${join(claude, "html")} links to ${join(skills, "html")}, which is gone: the skill is ah-page now`,
      fix: `ln -sfn ${join(skills, "ah-page")} ${join(claude, "ah-page")} && rm ${join(claude, "html")}`,
    },
    {
      problem: `${claude} doesn't have ah's ah-doc skill`,
      fix: `ln -s ${join(skills, "ah-doc")} ${claude}/`,
    },
  ])
})

test("a copy under an old name, but not someone else's skill of that name", () => {
  const codex = join(dir, "codex", "skills")
  skill(join(codex, "markdown"))
  skill(join(codex, "ah-page"))
  skill(join(codex, "panes"), "Some other panes skill")
  expect(installProblems([codex], skills, [])).toEqual([
    {
      problem: `${join(codex, "markdown")} is a copy of ah's markdown skill, which is ah-doc now`,
      fix: `rm -r ${join(codex, "markdown")} && cp -R ${join(skills, "ah-doc")} ${codex}/`,
    },
  ])
})

test("a harness without ah's skills is left alone; one with them needs the hooks", () => {
  const other = join(dir, "other", "skills")
  skill(join(other, "unrelated"), "nothing")
  const config = join(dir, "claude")
  mkdirSync(join(config, "skills"), { recursive: true })
  for (const name of ["ah-page", "ah-doc"])
    symlinkSync(join(skills, name), join(config, "skills", name))
  writeFileSync(join(config, "settings.json"), "{}")
  expect(installProblems([other, join(config, "skills")], skills, [config])).toEqual([
    {
      problem: `${join(config, "settings.json")} doesn't run \`ah hook agent\` on SessionStart, UserPromptSubmit, Stop, SessionEnd`,
      fix: expect.stringContaining("docs/setup.md"),
    },
  ])
})

test("each event the hook has to run on, for Claude Code", () => {
  const config = join(dir, "claude")
  mkdirSync(join(config, "skills"), { recursive: true })
  for (const name of ["ah-page", "ah-doc"])
    symlinkSync(join(skills, name), join(config, "skills", name))
  const hook = (command: string) => [{ hooks: [{ type: "command", command }] }]
  const hooks = {
    SessionStart: hook("ah hook agent"),
    UserPromptSubmit: hook("/opt/ah/ah.ts hook agent --harness claude"),
    Stop: hook("ah hook agent --harness codex"),
    Notification: hook("ah hook agent"),
  }
  writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks }))
  expect(installProblems([join(config, "skills")], skills, [config])).toEqual([
    expect.objectContaining({
      problem: `${join(config, "settings.json")} doesn't run \`ah hook agent\` on Stop, SessionEnd`,
    }),
  ])
})
