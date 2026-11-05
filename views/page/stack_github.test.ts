import { expect, test } from "vitest"
import { githubRepo, summarizeChecks } from "./stack_github.ts"

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
