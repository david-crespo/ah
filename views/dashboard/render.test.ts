import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { ansiToHtml } from "./ansi.ts"
import { isIgnored, opHeadsDir, SnapshotWatcher } from "./jj.ts"

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

const ESC = "\x1b"

test("ansiToHtml maps jj's 256-color output onto theme vars", () => {
  // the start of a real `jj log --color always` line
  const line = `${ESC}[1m${ESC}[38;5;2m@${ESC}[0m  ${ESC}[1m${ESC}[38;5;13mmu${ESC}[38;5;8mwp${ESC}[39m x${ESC}[0m`
  assertEquals(
    ansiToHtml(line),
    '<span style="color:var(--ansi-2);font-weight:bold">@</span>  ' +
      '<span style="color:var(--ansi-13);font-weight:bold">mu</span>' +
      '<span style="color:var(--ansi-8);font-weight:bold">wp</span>' +
      '<span style="font-weight:bold"> x</span>',
  )
})

test("ansiToHtml handles basic, bright, and truecolor codes", () => {
  assertEquals(
    ansiToHtml(`${ESC}[31ma${ESC}[m`),
    '<span style="color:var(--ansi-1)">a</span>',
  )
  assertEquals(ansiToHtml(`${ESC}[94ma`), '<span style="color:var(--ansi-12)">a</span>')
  assertEquals(ansiToHtml(`${ESC}[38;2;1;2;3ma`), '<span style="color:rgb(1,2,3)">a</span>')
})

test("ansiToHtml computes indexed colors past the theme's 16", () => {
  assertEquals(ansiToHtml(`${ESC}[38;5;17ma`), '<span style="color:rgb(0,0,95)">a</span>')
  assertEquals(
    ansiToHtml(`${ESC}[38;5;208ma`),
    '<span style="color:rgb(255,135,0)">a</span>',
  )
  assertEquals(
    ansiToHtml(`${ESC}[38;5;244ma`),
    '<span style="color:rgb(128,128,128)">a</span>',
  )
})

test("ansiToHtml escapes HTML and drops non-SGR sequences", () => {
  assertEquals(ansiToHtml(`<b>&${ESC}[2K${ESC}]8;;http://x${ESC}\\`), "&lt;b&gt;&amp;")
})

test("opHeadsDir follows a secondary workspace's repo pointer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-dashboard-"))
  try {
    mkdirSync(join(dir, "main", ".jj", "repo", "op_heads", "heads"), {
      recursive: true,
    })
    mkdirSync(join(dir, "ws", ".jj"), { recursive: true })
    writeFileSync(join(dir, "ws", ".jj", "repo"), "../../main/.jj/repo")
    const expected = join(dir, "main", ".jj", "repo", "op_heads", "heads")
    assertEquals(await opHeadsDir(join(dir, "main")), expected)
    assertEquals(await opHeadsDir(join(dir, "ws")), expected)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ansiToHtml wraps box-drawing characters in cell spans", () => {
  assertEquals(
    ansiToHtml("├─╯ x"),
    '<span class="bx bx-251c">├</span><span class="bx bx-2500">─</span>' +
      '<span class="bx bx-256f">╯</span> x',
  )
})

test("isIgnored skips jj state and build output anywhere in the tree", () => {
  assertEquals(
    [
      "src/main.rs",
      ".jj/repo/op_heads/heads/x",
      "web/node_modules/a/index.js",
      "target/debug/app",
      "application/src/x",
      "targets.md",
    ].map((p) => isIgnored(p)),
    [false, true, true, true, false, false],
  )
})

test("a SnapshotWatcher on a removed workspace logs instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-snapshot-"))
  rmSync(dir, { recursive: true })
  new SnapshotWatcher(dir, 1000).close()
})
