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
  bodyPath,
  ensureBody,
  parseGitDiff,
  parseStackFile,
  type Pr,
  readStack,
  type Shared,
  type Stack,
  STACK_FILE,
} from "./data.ts"

const prs = (stack: Stack) => stack.rows as Pr[]

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

test("parseStackFile wants a title and PRs with n, title and bookmark", () => {
  const ok = '{"title": "S", "prs": [{"n": 1, "title": "T", "bookmark": "b"}]}'
  expect(parseStackFile(ok)).toEqual(JSON.parse(ok))
  expect(() => parseStackFile('{"title": "S"}')).toThrow("a list of prs")
  expect(() => parseStackFile('{"title": "S", "prs": [{"n": 1, "title": "T"}]}')).toThrow(
    "n, title and bookmark",
  )
  const pr = '{"n": 1, "title": "T", "bookmark": "b"'
  expect(() => parseStackFile('{"title": "S", "notes": [1], "prs": []}')).toThrow("notes")
  for (const field of ['"summary": 2', '"merge": null'])
    expect(() => parseStackFile(`{"title": "S", "prs": [${pr}, ${field}}]}`)).toThrow(
      "summary and merge",
    )
})

test("readStack takes each PR's commits and base from the graph", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-")))
  const jj = (...args: string[]) =>
    execFileSync("jj", ["--config", "user.email=t@t", "--config", "user.name=t", ...args], {
      cwd: dir,
      stdio: "pipe",
    })
  const commit = (file: string, message: string) => {
    writeFileSync(join(dir, file), `${file}\n`)
    jj("commit", "-m", message)
  }
  try {
    jj("git", "init")
    // one, then two off it on a side branch, and three off one too
    commit("a.txt", "Add a\n\nThe body,\nwrapped.")
    commit("b.txt", "Add b")
    jj("bookmark", "create", "one", "-r", "@-")
    commit("c.txt", "Add c")
    jj("bookmark", "create", "two", "-r", "@-")
    jj("new", "one")
    commit("d.txt", "Add d")
    jj("bookmark", "create", "three", "-r", "@-")
    // one is pushed, then changed here
    execFileSync("git", ["init", "--bare", "--quiet", join(dir, "remote.git")])
    jj("git", "remote", "add", "origin", join(dir, "remote.git"))
    jj("git", "push", "--bookmark", "one")
    const pushed = jj(
      "log",
      "--no-graph",
      "-r",
      "one",
      "-T",
      "commit_id.short(8)",
    ).toString()
    jj("describe", "one", "-m", "Add b, edited")
    const notes = join(dir, "notes")
    mkdirSync(notes)
    const pr = (n: number, bookmark: string) => ({ n, title: `PR ${n}`, bookmark })
    const file = { title: "Stack", prs: [pr(1, "one"), pr(2, "two"), pr(3, "three")] }
    writeFileSync(join(notes, STACK_FILE), JSON.stringify(file))
    // A body's heading is the PR's title; one without a heading leaves it
    writeFileSync(join(notes, "two.md"), "# Two, from the body\n\nText\n")
    writeFileSync(join(notes, "three.md"), "Text\n")

    const stack = await readStack(join(notes, "index.html"))
    // No remote, so no trunk bookmark
    expect(stack.trunk).toBe("")
    expect(prs(stack).map((p) => p.title)).toEqual(["PR 3", "Two, from the body", "PR 1"])
    const summary = prs(stack).map((p) => ({
      n: p.n,
      base: p.base,
      diff: p.diff,
      pushed: p.pushed,
      unpushed: p.unpushed,
      commits: p.commits.map((c) => c.description.split("\n")[0]),
      files: p.files.map((f) => `${f.status} ${f.path} +${f.add}`),
    }))
    const base = prs(stack)[2].base
    expect(summary).toEqual([
      {
        n: 3,
        base: "one",
        diff: { from: '"one"', to: '"three"' },
        pushed: null,
        unpushed: 1,
        commits: ["Add d"],
        files: ["A d.txt +1"],
      },
      {
        n: 2,
        base: "one",
        diff: { from: '"one"', to: '"two"' },
        pushed: null,
        unpushed: 1,
        commits: ["Add c"],
        files: ["A c.txt +1"],
      },
      {
        n: 1,
        base: expect.stringMatching(/^[k-z]{8}$/),
        diff: { from: base, to: '"one"' },
        pushed,
        // The edit is still to push, and a isn't
        unpushed: 1,
        commits: ["Add b, edited", "Add a"],
        files: ["A a.txt +1", "A b.txt +1"],
      },
    ])
    const a = prs(stack)[2].commits[1]
    expect(a.description).toBe("Add a\n\nThe body,\nwrapped.\n")
    expect(a.files).toEqual([{ path: "a.txt", status: "A", add: 1, del: 0 }])
    expect(a.short.length).toBeGreaterThanOrEqual(4)

    // With only a body changed, its title is read again and jj isn't
    writeFileSync(join(notes, "two.md"), "# Two, retitled\n")
    const retitled = await readStack(join(notes, "index.html"))
    expect(prs(retitled)[1].title).toBe("Two, retitled")
    expect(prs(retitled)[1].commits).toBe(prs(stack)[1].commits)
    // After an operation, jj is
    jj("describe", "two", "-m", "Add c, edited")
    const edited = await readStack(join(notes, "index.html"))
    expect(prs(edited)[1].commits[0].description).toBe("Add c, edited\n")

    // A PR listed before its bookmark exists has no commits, and the rest
    // are as they were
    const four = { ...file, prs: [...file.prs, pr(4, "four")] }
    writeFileSync(join(notes, STACK_FILE), JSON.stringify(four))
    const withFour = await readStack(join(notes, "index.html"))
    expect(withFour.rows[0]).toMatchObject({
      n: 4,
      missing: true,
      diff: null,
      commits: [],
      files: [],
    })
    expect(withFour.rows.slice(1)).toEqual(edited.rows)
  } finally {
    rmSync(dir, { recursive: true })
  }
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
  return {
    dir,
    jj,
    /** Commits a file named for `name` and returns the commit's change ID */
    commit(name: string) {
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
      jj("commit", "-m", `Add ${name}`)
      return jj("log", "--no-graph", "-r", "@-", "-T", "change_id.short(8)")
    },
    /** The stack of PRs on `bookmarks`, numbered from 1. Its files are
     * written each time, since `jj new` on a commit without them removes
     * them. */
    async stack(...bookmarks: string[]) {
      mkdirSync(join(dir, "notes"), { recursive: true })
      const prs = bookmarks.map((bookmark, i) => ({ n: i + 1, title: "T", bookmark }))
      writeFileSync(join(dir, "notes", STACK_FILE), JSON.stringify({ title: "S", prs }))
      return await readStack(join(dir, "notes", "index.html"))
    },
  }
}

/** Each row's PR or the PRs it's shared by, its base and its commits */
const shape = (stack: Stack) =>
  stack.rows.map((r) => ({
    ...("n" in r ? { n: r.n } : { shared: r.prs, head: r.head }),
    base: r.base,
    commits: r.commits.map((c) => c.description.split("\n")[0]),
  }))

test("readStack shows commits below a fork with no PR's bookmark as shared", async () => {
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
    const prs = [{ n: 1, title: "One", bookmark: "one" }]
    writeFileSync(join(dir, "notes", STACK_FILE), JSON.stringify({ title: "S", prs }))
    // A config jj can't parse fails every command, trunk() among them
    writeFileSync(join(dir, "broken.toml"), "[user\nname = \n")
    process.env.JJ_CONFIG = join(dir, "broken.toml")
    await expect(readStack(join(dir, "notes", "index.html"))).rejects.toThrow()
  } finally {
    if (config === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = config
    rmSync(dir, { recursive: true })
  }
})

test("bodyPath names the body for its bookmark, next to the page", () => {
  expect(bodyPath("/s/index.html", "vdocs-draft")).toBe("/s/vdocs-draft.md")
  expect(bodyPath("/s/index.html", "v1.2_x")).toBe("/s/v1.2_x.md")
  expect(bodyPath("/s/index.html", "david/foo")).toBe("/s/david--foo.md")
  for (const bad of ["../x", ".hidden", ""])
    expect(bodyPath("/s/index.html", bad)).toBeNull()
})

test("ensureBody starts a PR's body with its title, and keeps one that's there", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-stack-")))
  const page = join(dir, "index.html")
  try {
    const prs = [{ n: 1, title: "One", bookmark: "one" }]
    writeFileSync(join(dir, STACK_FILE), JSON.stringify({ title: "S", prs }))
    expect(await ensureBody(page, "one")).toBe(join(dir, "one.md"))
    expect(readFileSync(join(dir, "one.md"), "utf8")).toBe("# One\n")
    writeFileSync(join(dir, "one.md"), "# Mine\n")
    await ensureBody(page, "one")
    expect(readFileSync(join(dir, "one.md"), "utf8")).toBe("# Mine\n")
    expect(await ensureBody(page, "other")).toBeNull()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
