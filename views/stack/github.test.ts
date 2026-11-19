import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { STACK_FILE } from "./data.ts"
import { githubRepo, readGithub, summarizeChecks } from "./github.ts"

// gh, faked: each call's arguments, and what it answers; jj runs for real
const gh = vi.hoisted(() => ({
  calls: [] as string[][],
  answer: (_args: string[]): string => "[]",
}))
vi.mock("../../platform/proc.ts", async (importOriginal) => {
  const proc = await importOriginal<typeof import("../../platform/proc.ts")>()
  return {
    ...proc,
    run: (cmd: string, args: string[], options?: object) => {
      if (cmd !== "gh") return proc.run(cmd, args, options)
      gh.calls.push(args)
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: gh.answer(args),
        stderr: "",
      })
    },
  }
})

test("readGithub asks gh once for the stack's PRs, by number", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-github-")))
  try {
    execFileSync("jj", ["git", "init"], { cwd: dir, stdio: "pipe" })
    execFileSync("jj", ["git", "remote", "add", "origin", "https://github.com/o/r"], {
      cwd: dir,
      stdio: "pipe",
    })
    // two isn't on GitHub yet, and GitHub has no PR 9
    const prs = [{ tip: "one", pr: 7 }, { tip: "two" }, { tip: "three", pr: 9 }]
    writeFileSync(join(dir, STACK_FILE), JSON.stringify({ title: "Stack", prs }))
    const pr = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: false,
      title: "One on GitHub",
      reviewDecision: null,
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: { nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
              },
            },
          },
        ],
      },
    }
    gh.calls = []
    gh.answer = (args) =>
      args[0] === "api"
        ? JSON.stringify({ data: { repository: { p0: pr, p1: null } } })
        : "[]"
    const github = await readGithub(join(dir, "index.html"))
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]).toEqual(
      expect.arrayContaining(["owner=o", "name=r", "-F", "p0=7", "p1=9"]),
    )
    const { commits: _, ...rest } = pr
    const want = { ...rest, reviewDecision: "", checks: "pass", stack: null }
    expect(github).toEqual({ one: want })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("readGithub finds the repo from a workspace whose working copy is stale", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-github-")))
  const other = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-github-")))
  try {
    const jj = (cwd: string, ...args: string[]) =>
      execFileSync("jj", args, { cwd, stdio: "pipe" })
    jj(dir, "git", "init")
    jj(dir, "git", "remote", "add", "origin", "https://github.com/o/r")
    // Rewriting this workspace's commit from another one leaves it stale
    jj(dir, "workspace", "add", join(other, "ws"))
    writeFileSync(join(other, "ws", "file"), "added from the other workspace")
    jj(join(other, "ws"), "squash", "--into", "default@")
    const prs = [{ tip: "one", pr: 1 }]
    writeFileSync(join(dir, STACK_FILE), JSON.stringify({ title: "Stack", prs }))
    gh.calls = []
    gh.answer = () => JSON.stringify({ data: { repository: { p0: null } } })
    expect(await readGithub(join(dir, "index.html"))).toEqual({})
    expect(gh.calls[0]).toEqual(expect.arrayContaining(["owner=o", "name=r"]))
  } finally {
    rmSync(dir, { recursive: true })
    rmSync(other, { recursive: true })
  }
})

test("readGithub has no PRs, and no error, for a repo with no GitHub remote", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-github-")))
  try {
    execFileSync("jj", ["git", "init"], { cwd: dir, stdio: "pipe" })
    const prs = [{ tip: "one", pr: 1 }]
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
