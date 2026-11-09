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
  readStack,
  STACK_FILE,
} from "./stack_data.ts"

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
    expect(stack.prs.map((p) => p.title)).toEqual(["PR 3", "Two, from the body", "PR 1"])
    const summary = stack.prs.map((p) => ({
      n: p.n,
      base: p.base,
      pushed: p.pushed,
      commits: p.commits.map((c) => c.description.split("\n")[0]),
      files: p.files.map((f) => `${f.status} ${f.path} +${f.add}`),
    }))
    expect(summary).toEqual([
      { n: 3, base: "one", pushed: null, commits: ["Add d"], files: ["A d.txt +1"] },
      { n: 2, base: "one", pushed: null, commits: ["Add c"], files: ["A c.txt +1"] },
      {
        n: 1,
        base: expect.stringMatching(/^[k-z]{8}$/),
        pushed,
        commits: ["Add b, edited", "Add a"],
        files: ["A a.txt +1", "A b.txt +1"],
      },
    ])
    const a = stack.prs[2].commits[1]
    expect(a.description).toBe("Add a\n\nThe body,\nwrapped.\n")
    expect(a.files).toEqual([{ path: "a.txt", status: "A", add: 1, del: 0 }])
    expect(a.short.length).toBeGreaterThanOrEqual(4)

    // With only a body changed, its title is read again and jj isn't
    writeFileSync(join(notes, "two.md"), "# Two, retitled\n")
    const retitled = await readStack(join(notes, "index.html"))
    expect(retitled.prs[1].title).toBe("Two, retitled")
    expect(retitled.prs[1].commits).toBe(stack.prs[1].commits)
    // After an operation, jj is
    jj("describe", "two", "-m", "Add c, edited")
    const edited = await readStack(join(notes, "index.html"))
    expect(edited.prs[1].commits[0].description).toBe("Add c, edited\n")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("readStack drops an earlier PR's commits from one that forks inside it", async () => {
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
    // one is a, b, c, d; two forks from b, not from one's tip; three is on one
    commit("a.txt", "Add a")
    commit("b.txt", "Add b")
    const b = jj("log", "--no-graph", "-r", "@-", "-T", "change_id.short(8)").toString()
    commit("c.txt", "Add c")
    commit("d.txt", "Add d")
    jj("bookmark", "create", "one", "-r", "@-")
    jj("new", b)
    commit("e.txt", "Add e")
    jj("bookmark", "create", "two", "-r", "@-")
    jj("new", "one")
    commit("f.txt", "Add f")
    jj("bookmark", "create", "three", "-r", "@-")
    const notes = join(dir, "notes")
    mkdirSync(notes)
    const pr = (n: number, bookmark: string) => ({ n, title: `PR ${n}`, bookmark })
    const prs = [pr(1, "one"), pr(2, "two"), pr(3, "three")]
    writeFileSync(join(notes, STACK_FILE), JSON.stringify({ title: "Stack", prs }))

    const stack = await readStack(join(notes, "index.html"))
    expect(
      stack.prs.map((p) => ({
        n: p.n,
        base: p.base,
        commits: p.commits.map((c) => c.description.split("\n")[0]),
        forksFrom: p.forksFrom,
      })),
    ).toEqual([
      { n: 3, base: "one", commits: ["Add f"], forksFrom: null },
      { n: 2, base: b, commits: ["Add e"], forksFrom: { n: 1, change: b } },
      {
        n: 1,
        base: expect.any(String),
        commits: ["Add d", "Add c", "Add b", "Add a"],
        forksFrom: null,
      },
    ])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("bodyPath names the body for its bookmark, next to the page", () => {
  expect(bodyPath("/s/index.html", "vdocs-draft")).toBe("/s/vdocs-draft.md")
  expect(bodyPath("/s/index.html", "v1.2_x")).toBe("/s/v1.2_x.md")
  for (const bad of ["../x", "a/b", ".hidden", ""])
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
