import { describe, expect, test } from "vitest"

// merge.ts needs node-diff3, which is only there when the CodeMirror pane's
// packages are installed (codemirror_pane.ts)
const merging = await import("./merge.ts").catch(() => null)
const { lineChanges, mergeDisk } = merging ?? ({} as typeof import("./merge.ts"))

const apply = (text: string, changes: ReturnType<typeof lineChanges>) => {
  let out = ""
  let at = 0
  for (const { from, to, insert } of changes) {
    expect(from).toBeGreaterThanOrEqual(at)
    out += text.slice(at, from) + insert
    at = to
  }
  return out + text.slice(at)
}

describe.skipIf(!merging)("with node-diff3", () => {
  test("mergeDisk keeps edits to different lines from both sides", () => {
    const base = "one\ntwo\nthree\nfour\n"
    const unsaved = "one\ntwo, typed\nthree\nfour\n"
    const disk = "one\ntwo\nthree\nfour, agent\n"
    expect(mergeDisk(base, unsaved, disk)).toEqual({
      text: "one\ntwo, typed\nthree\nfour, agent\n",
      conflict: false,
    })
  })

  test("mergeDisk leaves overlapping edits as conflict markers", () => {
    const base = "one\ntwo\nthree\n"
    const { text, conflict } = mergeDisk(base, "one\nmine\nthree\n", "one\ntheirs\nthree\n")
    expect(conflict).toBe(true)
    expect(text).toBe(
      "one\n<<<<<<< buffer (unsaved)\nmine\n=======\ntheirs\n>>>>>>> disk\nthree\n",
    )
  })

  test("mergeDisk takes the same edit on both sides once", () => {
    const base = "a\nb\n"
    expect(mergeDisk(base, "a\nc\n", "a\nc\n")).toEqual({ text: "a\nc\n", conflict: false })
  })

  test("lineChanges turns one text into the other", () => {
    const texts = [
      "",
      "\n",
      "one",
      "one\n",
      "one\ntwo\nthree\n",
      "zero\none\ntwo\nthree\n",
      "one\nthree\n",
      "one\ntwo\nthree\nfour",
      "two\n",
      "one\ntwo, edited\nthree\n",
    ]
    for (const before of texts) {
      for (const after of texts) {
        expect(apply(before, lineChanges(before, after)), `${before} -> ${after}`).toBe(
          after,
        )
      }
    }
  })

  test("lineChanges leaves the lines around a change alone", () => {
    expect(lineChanges("one\ntwo\nthree\n", "one\n2\nthree\n")).toEqual([
      { from: 4, to: 7, insert: "2" },
    ])
  })
})
