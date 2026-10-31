import { describe, expect, test } from "vitest"
import { lineChanges, mergeDisk } from "./merge.ts"

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

/** Paragraphs of unwrapped markdown */
const p = (...paras: string[]) => paras.join("\n\n") + "\n"

/** mergeDisk with each side given as edits of `base`, `[before, after]` */
const merge = (base: string, unsaved: [string, string][], disk: [string, string][]) => {
  const edit = (edits: [string, string][]) =>
    edits.reduce((text, [before, after]) => {
      expect(text).toContain(before)
      return text.replace(before, after)
    }, base)
  return mergeDisk(base, edit(unsaved), edit(disk))
}

describe("mergeDisk", () => {
  const session = p(
    "# Sessions",
    "Sessions are stored in a SQLite database. Each session row has an id, a title, and the time it was last opened. The dashboard reads this table on startup.",
    "Rex keeps one pty per pane. Scrollback is kept in memory only, so it doesn't survive a restart. If you need a log, pipe the command through tee.",
  )

  test("keeps edits to different paragraphs", () => {
    expect(
      merge(session, [["was last opened", "was last used"]], [["pipe the", "send the"]]),
    ).toBe(
      session.replace("was last opened", "was last used").replace("pipe the", "send the"),
    )
  })

  test("keeps edits to different words of one line", () => {
    expect(
      merge(session, [["a title", "a short title"]], [["last opened", "last active"]]),
    ).toBe(
      session.replace("a title", "a short title").replace("last opened", "last active"),
    )
  })

  test("keeps words typed right next to the other side's edit", () => {
    expect(
      merge(
        session,
        [["SQLite database.", "SQLite database, one per user."]],
        [["database. Each", "database. It's created on first run. Each"]],
      ),
    ).toBe(
      session.replace(
        "SQLite database.",
        "SQLite database, one per user. It's created on first run.",
      ),
    )
    const fox = "The quick brown fox.\n"
    // A word changed on one side, and the next one on the other
    expect(merge(fox, [["brown", "red"]], [["fox.", "fox jumps."]])).toBe(
      "The quick red fox jumps.\n",
    )
    // A word added right before one the other side replaced
    expect(merge(fox, [["The quick", "The very quick"]], [["quick", "slow"]])).toBe(
      "The very slow brown fox.\n",
    )
  })

  test("takes the same edit on both sides once", () => {
    expect(
      merge(
        session,
        [
          ["pty per", "PTY per"],
          ["a restart", "a server restart"],
        ],
        [
          ["pty per", "PTY per"],
          ["the command", "its output"],
        ],
      ),
    ).toBe(
      session
        .replace("pty per", "PTY per")
        .replace("a restart", "a server restart")
        .replace("the command", "its output"),
    )
  })

  test("leaves the rest of the file alone when neither side changed it", () => {
    const edited = session.replace("startup", "launch")
    expect(mergeDisk(session, edited, session)).toBe(edited)
    expect(mergeDisk(session, session, edited)).toBe(edited)
  })

  test("puts both versions of a word or two side by side, unsaved first", () => {
    const base = p("Merges are cheap, so we run them on every write.")
    expect(merge(base, [["cheap", "fast"]], [["cheap", "inexpensive"]])).toBe(
      p("Merges are fast inexpensive, so we run them on every write."),
    )
  })

  test("puts both versions of a bigger overlap as whole sentences", () => {
    expect(
      merge(
        session,
        [["a restart", "a server restart"]],
        [["so it doesn't survive a restart", "and is lost when the server stops"]],
      ),
    ).toBe(
      session.replace(
        "Scrollback is kept in memory only, so it doesn't survive a restart.",
        "Scrollback is kept in memory only, so it doesn't survive a server restart. Scrollback is kept in memory only, and is lost when the server stops.",
      ),
    )
  })

  test("keeps an edit to a sentence the other side deleted", () => {
    expect(
      merge(
        session,
        [["a restart", "a server restart"]],
        [["Scrollback is kept in memory only, so it doesn't survive a restart. ", ""]],
      ),
    ).toBe(session.replace("a restart", "a server restart"))
  })

  test("puts both versions of a heading or list item on lines of their own", () => {
    expect(
      merge(
        session,
        [["# Sessions", "# Saved sessions"]],
        [["# Sessions", "# Where sessions live on disk"]],
      ),
    ).toBe(session.replace("# Sessions", "# Saved sessions\n# Where sessions live on disk"))

    const list = p("Questions:", "- Run on every write?\n- What about undo?")
    expect(
      merge(
        list,
        [["undo?", "undo?\n- Do we need a setting?"]],
        [["undo?", "undo?\n- What about format-on-save?"]],
      ),
    ).toBe(
      list.replace("undo?", "undo?\n- Do we need a setting?\n- What about format-on-save?"),
    )
  })
})

describe("mergeDisk edge cases", () => {
  test("keeps the file's line endings and a missing last newline", () => {
    expect(mergeDisk("one two", "one two three", "zero one two")).toBe("zero one two three")
    expect(mergeDisk("a b\r\nc d\r\n", "a B\r\nc d\r\n", "a b\r\nc D\r\n")).toBe(
      "a B\r\nc D\r\n",
    )
  })

  test("merges words outside ASCII", () => {
    expect(
      mergeDisk(
        "Café naïve 日本語 test.\n",
        "Café très naïve 日本語 test.\n",
        "Café naïve 日本語 test 🎉.\n",
      ),
    ).toBe("Café très naïve 日本語 test 🎉.\n")
  })

  test("keeps both when both write a file that was empty", () => {
    expect(mergeDisk("", "mine\n", "theirs\n")).toBe("mine\ntheirs\n")
    expect(mergeDisk("", "same\n", "same\n")).toBe("same\n")
  })

  test("keeps an edit to a file the other side emptied", () => {
    expect(mergeDisk("a b c\n", "a B c\n", "")).toBe("a B c\n")
  })

  test("keeps both whole versions when both rewrote a long line", () => {
    // Past the diff's limit on edits, so each side is one replacement
    const line = (seed: number) =>
      Array.from({ length: 3000 }, (_, i) => `w${(i * seed) % 997}`).join(" ") + "\n"
    const [base, unsaved, disk] = [line(1), line(7), line(13)]
    expect(mergeDisk(base, unsaved, base)).toBe(unsaved)
    expect(mergeDisk(base, base, disk)).toBe(disk)
    const merged = mergeDisk(base, unsaved, disk)
    expect(merged.length).toBe(unsaved.length + disk.length)
    expect(merged.startsWith(unsaved.trimEnd())).toBe(true)
    expect(merged.endsWith(disk)).toBe(true)
  })
})

describe("mergeDisk on random edits", () => {
  // Seeded, so a failure reproduces
  let seed = 1
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
  const vocab = [
    "the",
    "merge",
    "buffer",
    "agent",
    "edits",
    "a",
    "file",
    "on",
    "disk,",
    "it",
  ]
  const word = () => vocab[random(vocab.length)]
  const sentence = () => Array.from({ length: 4 + random(10) }, word).join(" ") + "."
  const paragraph = () => Array.from({ length: 1 + random(4) }, sentence).join(" ")

  /** `text` with a few words inserted, deleted or replaced in paragraph `i` */
  const edit = (text: string, i: number) => {
    const paras = text.split("\n\n")
    const words = paras[i].split(" ")
    for (let n = 1 + random(3); n > 0; n--) {
      const at = random(words.length)
      const op = random(3)
      if (op === 0) words.splice(at, 0, word())
      else if (op === 1 && words.length > 1) words.splice(at, 1)
      else words[at] = word()
    }
    return paras.with(i, words.join(" ")).join("\n\n")
  }

  test("takes one side's edits whole when the other side made none, or the same", () => {
    for (let trial = 0; trial < 200; trial++) {
      const base = p(...Array.from({ length: 1 + random(6) }, paragraph))
      const paras = base.split("\n\n").length
      let edited = base
      for (let n = 1 + random(3); n > 0; n--) edited = edit(edited, random(paras))
      expect(mergeDisk(base, edited, base)).toBe(edited)
      expect(mergeDisk(base, base, edited)).toBe(edited)
      expect(mergeDisk(base, edited, edited)).toBe(edited)
    }
  })

  test("keeps both sides' edits to different paragraphs", () => {
    for (let trial = 0; trial < 200; trial++) {
      const paras = 2 + random(5)
      const base = p(...Array.from({ length: paras }, paragraph))
      const i = random(paras)
      const j = (i + 1 + random(paras - 1)) % paras
      const unsaved = edit(base, i)
      const disk = edit(base, j)
      const both = disk.split("\n\n").with(i, unsaved.split("\n\n")[i]).join("\n\n")
      expect(mergeDisk(base, unsaved, disk)).toBe(both)
    }
  })
})

describe("lineChanges", () => {
  test("turns one text into the other", () => {
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

  test("leaves the lines around a change alone", () => {
    expect(lineChanges("one\ntwo\nthree\n", "one\n2\nthree\n")).toEqual([
      { from: 4, to: 7, insert: "2" },
    ])
  })
})
