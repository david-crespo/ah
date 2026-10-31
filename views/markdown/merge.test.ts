import { describe, expect, test } from "vitest"
import { AGENT, lineChanges, MINE, mergeDisk, pick } from "./merge.ts"

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

/** mergeDisk's text */
const merged = (base: string, unsaved: string, disk: string) =>
  mergeDisk(base, unsaved, disk).text

/** mergeDisk's text with each side given as edits of `base`, `[before, after]` */
const merge = (base: string, unsaved: [string, string][], disk: [string, string][]) => {
  const edit = (edits: [string, string][]) =>
    edits.reduce((text, [before, after]) => {
      expect(text).toContain(before)
      return text.replace(before, after)
    }, base)
  return merged(base, edit(unsaved), edit(disk))
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
    expect(merged(session, edited, session)).toBe(edited)
    expect(merged(session, session, edited)).toBe(edited)
  })

  test("marks both versions of a word or two, unsaved first", () => {
    const base = p("Merges are cheap, so we run them on every write.")
    const fast = base.replace("cheap", "fast")
    expect(mergeDisk(base, fast, base.replace("cheap", "inexpensive"))).toEqual({
      text: p("Merges are {~~fast~>inexpensive~~}, so we run them on every write."),
      conflicts: 1,
    })
    expect(mergeDisk(base, fast, fast).conflicts).toBe(0)
    expect(
      merge(base, [["are cheap", "are very cheap"]], [["are cheap", "are quite cheap"]]),
    ).toBe(p("Merges are {~~very~>quite~~} cheap, so we run them on every write."))
  })

  test("marks both versions of a bigger overlap as whole sentences", () => {
    expect(
      merge(
        session,
        [["a restart", "a server restart"]],
        [["so it doesn't survive a restart", "and is lost when the server stops"]],
      ),
    ).toBe(
      session.replace(
        "Scrollback is kept in memory only, so it doesn't survive a restart.",
        "{~~Scrollback is kept in memory only, so it doesn't survive a server restart.~>Scrollback is kept in memory only, and is lost when the server stops.~~}",
      ),
    )
  })

  test("marks an edit to a sentence the other side deleted", () => {
    expect(
      merge(
        session,
        [["a restart", "a server restart"]],
        [["Scrollback is kept in memory only, so it doesn't survive a restart. ", ""]],
      ),
    ).toBe(
      session.replace(
        "Scrollback is kept in memory only, so it doesn't survive a restart.",
        "{~~Scrollback is kept in memory only, so it doesn't survive a server restart.~>~~}",
      ),
    )
  })

  test("marks edits across lines with git's markers around the lines", () => {
    const paragraph = session.split("\n\n")[2].trimEnd()
    expect(
      merge(session, [["a restart", "a server restart"]], [["\n\n" + paragraph, ""]]),
    ).toBe(
      session.replace(
        "\n\n" + paragraph,
        `\n<<<<<<< mine\n\n${paragraph.replace("a restart", "a server restart")}\n=======\n>>>>>>> agent`,
      ),
    )
  })

  test("marks only the text after a heading or list item's marker", () => {
    expect(
      merge(
        session,
        [["# Sessions", "# Saved sessions"]],
        [["# Sessions", "# Where sessions live on disk"]],
      ),
    ).toBe(
      session.replace("# Sessions", "# {~~Saved sessions~>Where sessions live on disk~~}"),
    )
    expect(
      merged("- one task\n- two\n", "- one big task\n- two\n", "- one small task\n- two\n"),
    ).toBe("- one {~~big~>small~~} task\n- two\n")
  })

  test("keeps lines both added at one spot, unsaved first", () => {
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
    expect(merged("one two", "one two three", "zero one two")).toBe("zero one two three")
    expect(merged("a b\r\nc d\r\n", "a B\r\nc d\r\n", "a b\r\nc D\r\n")).toBe(
      "a B\r\nc D\r\n",
    )
  })

  test("merges words outside ASCII", () => {
    expect(
      merged(
        "Café naïve 日本語 test.\n",
        "Café très naïve 日本語 test.\n",
        "Café naïve 日本語 test 🎉.\n",
      ),
    ).toBe("Café très naïve 日本語 test 🎉.\n")
  })

  test("keeps both when both write a file that was empty", () => {
    expect(merged("", "mine\n", "theirs\n")).toBe("mine\ntheirs\n")
    expect(merged("", "same\n", "same\n")).toBe("same\n")
  })

  test("marks an edit to a file the other side emptied", () => {
    expect(merged("a b c\n", "a B c\n", "")).toBe(
      "<<<<<<< mine\na B c\n=======\n>>>>>>> agent\n",
    )
  })

  test("marks both whole versions when both rewrote a long line", () => {
    // Past the diff's limit on edits, so each side is one replacement
    const line = (seed: number) =>
      Array.from({ length: 3000 }, (_, i) => `w${(i * seed) % 997}`).join(" ") + "\n"
    const [base, unsaved, disk] = [line(1), line(7), line(13)]
    expect(merged(base, unsaved, base)).toBe(unsaved)
    expect(merged(base, base, disk)).toBe(disk)
    expect(merged(base, unsaved, disk)).toBe(
      `{~~${unsaved.trimEnd()}~>${disk.trimEnd()}~~}\n`,
    )
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
      expect(merged(base, edited, base)).toBe(edited)
      expect(merged(base, base, edited)).toBe(edited)
      expect(merged(base, edited, edited)).toBe(edited)
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
      expect(mergeDisk(base, unsaved, disk)).toEqual({ text: both, conflicts: 0 })
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

describe("pick", () => {
  const text = "One {~~two~>2~~} three.\n<<<<<<< mine\nfour\n=======\n>>>>>>> agent\nfive\n"
  test("resolves the conflict at an offset to one side", () => {
    expect(pick(text, 4, MINE)).toBe(text.replace("{~~two~>2~~}", "two"))
    expect(pick(text, 4, AGENT)).toBe(text.replace("{~~two~>2~~}", "2"))
    const lines = text.indexOf("<<<<<<<")
    expect(pick(text, lines, MINE)).toBe("One {~~two~>2~~} three.\nfour\nfive\n")
    expect(pick(text, lines, AGENT)).toBe("One {~~two~>2~~} three.\nfive\n")
  })

  test("finds none anywhere else", () => {
    expect(pick(text, 0, MINE)).toBeNull()
    expect(pick(text, 5, MINE)).toBeNull()
    expect(pick("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n", 0, MINE)).toBeNull()
  })

  test("undoes what the merge marked", () => {
    const base = "Merges are cheap.\n\nThey run on every write.\n"
    const unsaved = "Merges are fast.\n\nThey run on every save.\n"
    const disk = "Merges are inexpensive.\n"
    let { text } = mergeDisk(base, unsaved, disk)
    for (let at = text.search(/\{~~|<<<<<<</); at >= 0; at = text.search(/\{~~|<<<<<<</))
      text = pick(text, at, MINE)!
    expect(text).toBe(unsaved)
  })
})
