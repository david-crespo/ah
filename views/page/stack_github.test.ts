import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { STACK_FILE } from "./stack_data.ts"
import { githubRepo, readGithub, summarizeChecks } from "./stack_github.ts"

test("readGithub has no PRs, and no error, for a repo with no GitHub remote", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-github-")))
  try {
    execFileSync("jj", ["git", "init"], { cwd: dir, stdio: "pipe" })
    const prs = [{ n: 1, title: "One", bookmark: "one" }]
    writeFileSync(join(dir, STACK_FILE), JSON.stringify({ title: "Stack", prs }))
    expect(await readGithub(join(dir, "index.html"))).toEqual({})
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("githubRepo takes origin's owner/name, over other remotes", () => {
  const remotes = [
    "fork git@github.com:me/docs.git",
    "origin https://github.com/oxidecomputer/docs.git",
    "",
  ].join("\n")
  expect(githubRepo(remotes)).toBe("oxidecomputer/docs")
  expect(githubRepo("up git@github.com:o/r")).toBe("o/r")
  expect(githubRepo("origin https://gitlab.com/o/r.git")).toBeNull()
})

test("summarizeChecks: any failure fails, then anything unfinished is pending", () => {
  const done = { status: "COMPLETED", conclusion: "SUCCESS" }
  expect(summarizeChecks([])).toBeNull()
  expect(summarizeChecks([done, { state: "SUCCESS" }])).toBe("pass")
  expect(summarizeChecks([done, { status: "IN_PROGRESS", conclusion: "" }])).toBe("pending")
  expect(summarizeChecks([done, { state: "PENDING" }])).toBe("pending")
  expect(
    summarizeChecks([
      { status: "IN_PROGRESS" },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ]),
  ).toBe("fail")
})
