import { expect, test } from "vitest"
import { diffArgs, sendCommand } from "./skepsis.ts"

test("diffArgs takes a revision or a range, and no flags", () => {
  expect(diffArgs({ rev: "ktxrpslz" })).toEqual(["-r", "ktxrpslz"])
  expect(diffArgs({ from: "one", to: "two" })).toEqual(["--from", "one", "--to", "two"])
  expect(diffArgs({ from: "one", to: "two", interdiff: true })).toEqual([
    "--interdiff",
    "--from",
    "one",
    "--to",
    "two",
  ])
  for (const body of [
    null,
    "ktxr",
    {},
    { rev: "" },
    { rev: "--send=sh" },
    { rev: "a b" },
    { from: "one" },
    { from: "-x", to: "two" },
    { from: "one", to: "-x" },
  ]) {
    expect(diffArgs(body)).toBeNull()
  }
})

test("sendCommand quotes the agent for the shell", () => {
  expect(sendCommand("block:1")).toBe("jq -r .prompt | ah message send --agent 'block:1'")
  expect(sendCommand("a'b")).toBe(`jq -r .prompt | ah message send --agent 'a'\\''b'`)
})
