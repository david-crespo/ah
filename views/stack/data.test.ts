import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import {
  ensureBody,
  parseGitDiff,
  parseStackFile,
  type Pr,
  readStack,
  type Shared,
  type Stack,
  type StackEntry,
  STACK_FILE,
} from "./data.ts"

const prs = (stack: Stack) => stack.rows.filter((r): r is Pr => "n" in r)

test("parseGitDiff counts each file's lines and reads its status", () => {
  const diff = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 0000000000..1111111111",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+a",
    "+++b",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "--x",
    "diff --git a/a.ts b/b.ts",
    "rename from a.ts",
    "rename to b.ts",
    "@@ -3,1 +3,1 @@",
    "-y",
    "+z",
    "\\ No newline at end of file",
    "",
  ].join("\n")
  expect(parseGitDiff(diff)).toEqual([
    { path: "new.ts", status: "A", add: 2, del: 0 },
    { path: "old.ts", status: "D", add: 0, del: 1 },
    { path: "b.ts", status: "R", add: 1, del: 1 },
  ])
})

test("parseStackFile reads jj-spr's format, with ah's title and notes", () => {
  const ok = JSON.stringify({
    title: "S",
    notes: ["n"],
    prs: [
      { tip: "a", body: "a.md", pr: 5, branch: "spr/a", synced: "x", pushed: "ab12" },
      { tip: "kxqzwmvt", title: "T", merged: true },
    ],
  })
  expect(parseStackFile(ok)).toEqual(JSON.parse(ok))
  // As jj-spr's init writes it, with no title
  expect(parseStackFile('{"prs": [{"tip": "a"}]}')).toEqual({ prs: [{ tip: "a" }] })
  expect(() => parseStackFile('{"title": "S"}')).toThrow("a list of prs")
  expect(() => parseStackFile('{"prs": [{"title": "T"}]}')).toThrow("needs a tip")
  expect(() => parseStackFile('{"prs": [{"tip": "a", "pr": "5"}]}')).toThrow("pr a number")
  expect(() => parseStackFile('{"notes": [1], "prs": []}')).toThrow("notes")
})

/** A new jj repo for a test, its commits made one file each */
function testRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-")))
  const jj = (...args: string[]) =>
    execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
      cwd: dir,
      stdio: "pipe",
    }).toString()
  jj("git", "init")
  const notes = join(dir, "notes")
  return {
    dir,
    notes,
    jj,
    /** Commits a file named for `name`, with `message`, and returns the
     * commit's change ID */
    commit(name: string, message = `Add ${name}`) {
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
      jj("commit", "-m", message)
      return jj("log", "--no-graph", "-r", "@-", "-T", "change_id.short(8)")
    },
    /** The commit ID `rev` is at */
    commitId: (rev: string) => jj("log", "--no-graph", "-r", rev, "-T", "commit_id"),
    /** The stack of `entries`, or of PRs on these tips. Its files are
     * written each time, since `jj new` on a commit without them removes
     * them. */
    async stack(...entries: (string | StackEntry)[]) {
      mkdirSync(notes, { recursive: true })
      const prs = entries.map((e) => (typeof e === "string" ? { tip: e, title: "T" } : e))
      writeFileSync(join(notes, STACK_FILE), JSON.stringify({ title: "S", prs }))
      return await readStack(join(notes, "index.html"))
    },
  }
}

test("readStack takes each PR's commits and base from the graph", async () => {
  const repo = testRepo()
  try {
    // one, then two off it on a side branch, and three off one too, by its
    // change ID
    repo.commit("a", "Add a\n\nThe body,\nwrapped.")
    repo.commit("b")
    repo.jj("bookmark", "create", "one", "-r", "@-")
    repo.commit("c")
    repo.jj("bookmark", "create", "two", "-r", "@-")
    repo.jj("new", "one")
    const three = repo.jj("log", "--no-graph", "-r", "@", "-T", "change_id.short(12)")
    repo.commit("d")
    // A body's heading is the PR's title; one without a heading leaves it
    mkdirSync(repo.notes)
    writeFileSync(join(repo.notes, "two.md"), "# Two, from the body\n\nText\n")
    writeFileSync(join(repo.notes, "three.md"), "Text\n")
    const file: StackEntry[] = [
      { tip: "one", title: "PR 1" },
      { tip: "two", title: "PR 2", body: "two.md" },
      { tip: three, title: "PR 3", body: "three.md" },
    ]

    const stack = await repo.stack(...file)
    expect(stack.title).toBe("S")
    expect(prs(stack).map((p) => p.title)).toEqual(["PR 3", "Two, from the body", "PR 1"])
    const summary = prs(stack).map((p) => ({
      n: p.n,
      base: p.base,
      diff: p.diff,
      commits: p.commits.map((c) => c.description.split("\n")[0]),
      files: p.files.map((f) => `${f.status} ${f.path} +${f.add}`),
    }))
    const base = prs(stack)[2].base
    expect(summary).toEqual([
      {
        n: 3,
        base: "one",
        // A change ID unquoted, as a revset
        diff: { from: '"one"', to: three },
        commits: ["Add d"],
        files: ["A d.txt +1"],
      },
      {
        n: 2,
        base: "one",
        diff: { from: '"one"', to: '"two"' },
        commits: ["Add c"],
        files: ["A c.txt +1"],
      },
      {
        n: 1,
        base: expect.stringMatching(/^[k-z]{8}$/),
        diff: { from: base, to: '"one"' },
        commits: ["Add b", "Add a"],
        files: ["A a.txt +1", "A b.txt +1"],
      },
    ])
    const a = prs(stack)[2].commits[1]
    expect(a.description).toBe("Add a\n\nThe body,\nwrapped.\n")
    expect(a.files).toEqual([{ path: "a.txt", status: "A", add: 1, del: 0 }])
    expect(a.short.length).toBeGreaterThanOrEqual(4)

    // With only a body changed, its title is read again and jj isn't
    writeFileSync(join(repo.notes, "two.md"), "# Two, retitled\n")
    const retitled = await readStack(join(repo.notes, "index.html"))
    expect(prs(retitled)[1].title).toBe("Two, retitled")
    expect(prs(retitled)[1].commits).toBe(prs(stack)[1].commits)
    // After an operation, jj is
    repo.jj("describe", "two", "-m", "Add c, edited")
    const edited = await readStack(join(repo.notes, "index.html"))
    expect(prs(edited)[1].commits[0].description).toBe("Add c, edited\n")

    // A PR whose tip isn't there yet has no commits and comes first; a
    // merged one, which jj-spr leaves out, comes last; and the rest are as
    // they were
    const more = await repo.stack(
      { tip: "zero", title: "PR 0", pr: 4, merged: true },
      ...file,
      { tip: "four", title: "PR 4" },
    )
    expect(more.rows[0]).toMatchObject({ n: 5, missing: true, diff: null, commits: [] })
    expect(more.rows.at(-1)).toMatchObject({ n: 1, merged: true, missing: false, pr: 4 })
    const renumbered = (rows: Stack["rows"]) => rows.map((r) => ("n" in r ? r.tip : r))
    expect(renumbered(more.rows.slice(1, -1))).toEqual(renumbered(edited.rows))
  } finally {
    rmSync(repo.dir, { recursive: true })
  }
})

/** Each row's PR or the PRs it's shared by, its base and its commits */
const shape = (stack: Stack) =>
  stack.rows.map((r) => ({
    ...("n" in r ? { n: r.n } : { shared: r.prs, head: r.head }),
    base: r.base,
    commits: r.commits.map((c) => c.description.split("\n")[0]),
  }))

test("readStack shows commits below a fork with no PR's tip as shared", async () => {
  const repo = testRepo()
  try {
    // ○ v four
    // ○ u three
    // ○ t
    // │ ○ k two
    // ├─╯
    // ○ w
    // ○ s
    // ○ a one
    const root = repo.jj("log", "--no-graph", "-r", "root()", "-T", "change_id.short(8)")
    repo.commit("a")
    repo.jj("bookmark", "create", "one", "-r", "@-")
    repo.commit("s")
    const w = repo.commit("w")
    repo.commit("k")
    repo.jj("bookmark", "create", "two", "-r", "@-")
    repo.jj("new", w)
    repo.commit("t")
    repo.commit("u")
    repo.jj("bookmark", "create", "three", "-r", "@-")
    repo.commit("v")
    repo.jj("bookmark", "create", "four", "-r", "@-")
    const stack = await repo.stack("one", "two", "three", "four")
    expect(shape(stack)).toEqual([
      { n: 4, base: "three", commits: ["Add v"] },
      { n: 3, base: w, commits: ["Add u", "Add t"] },
      { n: 2, base: w, commits: ["Add k"] },
      { shared: [2, 3], head: w, base: "one", commits: ["Add w", "Add s"] },
      { n: 1, base: root, commits: ["Add a"] },
    ])
    const shared = stack.rows[3] as Shared
    expect(shared.diff).toEqual({ from: '"one"', to: w })
    expect(shared.files.map((f) => f.path)).toEqual(["s.txt", "w.txt"])
    expect(prs(stack)[1].diff).toEqual({ from: w, to: '"three"' })

    // Any number of PRs share them, and the one leading to the highest PR
    // comes first
    repo.jj("new", w)
    repo.commit("x")
    repo.jj("bookmark", "create", "five", "-r", "@-")
    const five = await repo.stack("one", "two", "three", "four", "five")
    expect(shape(five).map((r) => ("n" in r ? r.n : r.shared))).toEqual([
      5,
      4,
      3,
      2,
      [2, 3, 5],
      1,
    ])
  } finally {
    rmSync(repo.dir, { recursive: true })
  }
})

test("readStack tags what changed since jj-spr's pushed commit, and nothing without one", async () => {
  const repo = testRepo()
  try {
    repo.commit("a")
    repo.jj("bookmark", "create", "one", "-r", "@-")
    const b = repo.commit("b")
    const c = repo.commit("c")
    const d = repo.commit("d")
    repo.jj("bookmark", "create", "two", "-r", "@-")
    // As jj-spr last pushed them
    const pushed = { one: repo.commitId("one"), two: repo.commitId("two") }
    // A commit on one moves two's up; then c changes a line and d its
    // description
    repo.jj("new", "--insert-after", "one", "-m", "Add e")
    writeFileSync(join(repo.dir, "e.txt"), "e\n")
    repo.jj("bookmark", "set", "one", "-r", "@")
    repo.jj("edit", c)
    writeFileSync(join(repo.dir, "c.txt"), "C\n")
    repo.jj("describe", d, "-m", "Add d, edited")
    repo.jj("new", "two")
    const stack = await repo.stack(
      { tip: "one", pr: 1, pushed: pushed.one },
      { tip: "two", pr: 2, pushed: pushed.two },
    )
    const pr = (n: number) => prs(stack).find((p) => p.n === n)!
    const rewrites = (n: number) => pr(n).commits.map((c) => [c.change, c.rewrite ?? null])
    const from = expect.stringMatching(/^[0-9a-f]{40}$/)
    expect(rewrites(2)).toEqual([
      [d, { from, add: 0, del: 0, reworded: true }],
      [c, { from, add: 1, del: 1, reworded: false }],
      [b, { from, add: 0, del: 0, reworded: false }],
    ])
    // e is new, and a is pushed
    expect(rewrites(1).map(([, r]) => r)).toEqual([null, null])
    expect([pr(2).unpushed, pr(1).unpushed]).toEqual([3, 1])
    expect(pr(2).pushed).toBe(pushed.two)
    // Each PR's interdiff: its commits as pushed, against its commits here,
    // apart from what's below it
    const changes = (revset: string) =>
      repo.jj("log", "--no-graph", "-r", revset, "-T", 'change_id.short(8) ++ " "').trim()
    expect(changes(pr(2).interdiff!.from)).toEqual(`${d} ${c} ${b}`)
    expect(changes(pr(2).interdiff!.to)).toEqual(`${d} ${c} ${b}`)
    expect(changes(pr(1).interdiff!.to).split(" ")).toHaveLength(2)
    expect(changes(pr(1).interdiff!.from).split(" ")).toHaveLength(1)
    // and what it shows: c's line, d's description, and all of new e
    expect(pr(2).interdiff).toMatchObject({ add: 1, del: 1, reworded: true })
    expect(pr(1).interdiff).toMatchObject({ add: 1, del: 0 })

    // Without pushed, or with one that isn't here, nothing is to push
    const unknown = await repo.stack(
      { tip: "one", pr: 1 },
      { tip: "two", pr: 2, pushed: "0123456789abcdef0123456789abcdef01234567" },
    )
    for (const p of prs(unknown))
      expect(p).toMatchObject({ pushed: null, unpushed: 0, interdiff: null })
    expect(
      prs(unknown)
        .flatMap((p) => p.commits)
        .some((c) => c.rewrite),
    ).toBe(false)
  } finally {
    rmSync(repo.dir, { recursive: true })
  }
})

test("readStack shares the commits below a PR that forks inside another", async () => {
  const repo = testRepo()
  try {
    // ○ f three
    // ○ d one
    // ○ c
    // │ ○ e two
    // ├─╯
    // ○ b
    // ○ a
    const root = repo.jj("log", "--no-graph", "-r", "root()", "-T", "change_id.short(8)")
    repo.commit("a")
    const b = repo.commit("b")
    repo.commit("c")
    repo.commit("d")
    repo.jj("bookmark", "create", "one", "-r", "@-")
    repo.jj("new", b)
    repo.commit("e")
    repo.jj("bookmark", "create", "two", "-r", "@-")
    repo.jj("new", "one")
    repo.commit("f")
    repo.jj("bookmark", "create", "three", "-r", "@-")
    // One's own commits start above them, and they're above trunk with no
    // PR below
    expect(shape(await repo.stack("one", "two", "three"))).toEqual([
      { n: 3, base: "one", commits: ["Add f"] },
      { n: 1, base: b, commits: ["Add d", "Add c"] },
      { n: 2, base: b, commits: ["Add e"] },
      { shared: [1, 2], head: b, base: root, commits: ["Add b", "Add a"] },
    ])
  } finally {
    rmSync(repo.dir, { recursive: true })
  }
})

test("readStack rejects when jj fails, and leaves no rejection unhandled", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-")))
  const config = process.env.JJ_CONFIG
  try {
    execFileSync("jj", ["git", "init"], { cwd: dir, stdio: "pipe" })
    mkdirSync(join(dir, "notes"))
    const prs = [{ tip: "one" }]
    writeFileSync(join(dir, "notes", STACK_FILE), JSON.stringify({ prs }))
    // A config jj can't parse fails every command
    writeFileSync(join(dir, "broken.toml"), "[user\nname = \n")
    process.env.JJ_CONFIG = join(dir, "broken.toml")
    await expect(readStack(join(dir, "notes", "index.html"))).rejects.toThrow()
  } finally {
    if (config === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = config
    rmSync(dir, { recursive: true })
  }
})

test("ensureBody starts a PR's body with its title, and keeps one that's there", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-")))
  const page = join(dir, "index.html")
  try {
    const prs = [
      { tip: "one", title: "One", body: "one.md" },
      { tip: "two", title: "Two" },
    ]
    writeFileSync(join(dir, STACK_FILE), JSON.stringify({ prs }))
    expect(await ensureBody(page, "one")).toBe(join(dir, "one.md"))
    expect(readFileSync(join(dir, "one.md"), "utf8")).toBe("# One\n")
    writeFileSync(join(dir, "one.md"), "# Mine\n")
    await ensureBody(page, "one")
    expect(readFileSync(join(dir, "one.md"), "utf8")).toBe("# Mine\n")
    // No body file in the stack file, or no such PR
    expect(await ensureBody(page, "two")).toBeNull()
    expect(await ensureBody(page, "other")).toBeNull()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
