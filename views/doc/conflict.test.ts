import { test } from "vitest"
import { findConflictEnd, parseConflict } from "./conflict.ts"

function assertEq(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}
function parse(text: string) {
  const lines = text.split("\n")
  const end = findConflictEnd(lines, 0)
  if (end < 0) throw new Error("no conflict end")
  return parseConflict(lines, 0, end)
}

test("jj diff style rebuilds side and base from the diff", () => {
  const c = parse(`<<<<<<< Conflict 1 of 1
%%%%%%% Changes from base to side #1
 Shared intro.
-The old line.
+The new line.
+++++++ Contents of side #2
Shared intro.
A different line.
>>>>>>> Conflict 1 of 1 ends`)
  assertEq(c.title, "Conflict 1 of 1")
  assertEq(
    c.panels.map((p) => [p.kind, p.label, p.text, p.changed]),
    [
      ["side", "Side #1", "Shared intro.\nThe new line.", ["The new line."]],
      ["base", "Base", "Shared intro.\nThe old line.", ["The old line."]],
      ["side", "Side #2", "Shared intro.\nA different line.", undefined],
    ],
  )
})

test("jj snapshot style", () => {
  const c = parse(`<<<<<<< Conflict 1 of 2
+++++++ Contents of side #1
one
------- Contents of base
zero
+++++++ Contents of side #2
two
>>>>>>> Conflict 1 of 2 ends`)
  assertEq(c.title, "Conflict 1 of 2")
  assertEq(
    c.panels.map((p) => [p.kind, p.label, p.text]),
    [
      ["side", "Side #1", "one"],
      ["base", "Base", "zero"],
      ["side", "Side #2", "two"],
    ],
  )
})

test("git diff3 style uses branch names as labels", () => {
  const c = parse(`<<<<<<< HEAD
ours
||||||| base
orig
=======
theirs
>>>>>>> feature`)
  assertEq(c.title, "Merge conflict")
  assertEq(
    c.panels.map((p) => [p.kind, p.label, p.text]),
    [
      ["side", "HEAD", "ours"],
      ["base", "base", "orig"],
      ["side", "feature", "theirs"],
    ],
  )
})

test("git two-way style and an empty side", () => {
  const c = parse(`<<<<<<< HEAD
=======
theirs
>>>>>>> feature`)
  assertEq(
    c.panels.map((p) => [p.kind, p.label, p.text]),
    [
      ["side", "HEAD", ""],
      ["side", "feature", "theirs"],
    ],
  )
})

test("longer markers must match in length", () => {
  const lines = [
    "<<<<<<<< Conflict 1 of 1",
    ">>>>>>> nope",
    ">>>>>>>> Conflict 1 of 1 ends",
  ]
  assertEq(findConflictEnd(lines, 0), 2)
  assertEq(findConflictEnd(["<<<<<<< x", "text"], 0), -1)
  assertEq(findConflictEnd(["<<<<<<<x", ">>>>>>> x"], 0), -1)
})
