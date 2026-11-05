import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { parseGitDiff, parseStackFile, readStack, STACK_FILE } from "./stack_data.ts"

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
    const notes = join(dir, "notes")
    mkdirSync(notes)
    const pr = (n: number, bookmark: string) => ({ n, title: `PR ${n}`, bookmark })
    const file = { title: "Stack", prs: [pr(1, "one"), pr(2, "two"), pr(3, "three")] }
    writeFileSync(join(notes, STACK_FILE), JSON.stringify(file))

    const stack = await readStack(join(notes, "index.html"))
    const summary = stack.prs.map((p) => ({
      n: p.n,
      base: p.base,
      commits: p.commits.map((c) => c.description.split("\n")[0]),
      files: p.files.map((f) => `${f.status} ${f.path} +${f.add}`),
    }))
    expect(summary).toEqual([
      { n: 3, base: "one", commits: ["Add d"], files: ["A d.txt +1"] },
      { n: 2, base: "one", commits: ["Add c"], files: ["A c.txt +1"] },
      {
        n: 1,
        base: expect.stringMatching(/^[k-z]{8}$/),
        commits: ["Add b", "Add a"],
        files: ["A a.txt +1", "A b.txt +1"],
      },
    ])
    const a = stack.prs[2].commits[1]
    expect(a.description).toBe("Add a\n\nThe body,\nwrapped.\n")
    expect(a.files).toEqual([{ path: "a.txt", status: "A", add: 1, del: 0 }])
    expect(a.short.length).toBeGreaterThanOrEqual(4)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
