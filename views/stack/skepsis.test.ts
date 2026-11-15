import { expect, test } from "vitest"
import { diffArgs } from "./skepsis.ts"

test("diffArgs takes a revision or a range, and no flags", () => {
  expect(diffArgs({ rev: "ktxrpslz" })).toEqual({ rev: "ktxrpslz" })
  expect(diffArgs({ from: "one", to: "two" })).toEqual({
    from: "one",
    to: "two",
    interdiff: false,
  })
  expect(diffArgs({ from: "one", to: "two", interdiff: true })).toEqual({
    from: "one",
    to: "two",
    interdiff: true,
  })
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
