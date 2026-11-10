import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { isServeCommand, stopServer } from "./server.ts"

test("isServeCommand knows the server however ah was run", () => {
  for (const command of [
    "node /opt/homebrew/bin/ah server serve --port 7420",
    "/usr/local/bin/node /Users/x/repos/ah/ah.ts server serve --port 7420",
    "node /Users/x/lib/node_modules/@david-crespo/ah/dist/ah.js server serve --port 7420",
  ])
    expect(isServeCommand(command)).toBe(true)
  expect(isServeCommand("node /opt/homebrew/bin/ah server status")).toBe(false)
  expect(isServeCommand("node /x/blah server serve")).toBe(false)
})

test("stop kills a server that doesn't answer, from its pid file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-server-"))
  // Nothing listens on port 1, so this stand-in never answers
  const hung = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
    "ah.ts",
    "server",
    "serve",
  ])
  const exited = new Promise((resolve) => hung.on("exit", resolve))
  const files = { pid: join(dir, "serve.pid"), log: join(dir, "serve.log") }
  writeFileSync(files.pid, JSON.stringify({ pid: hung.pid, port: 1 }))
  try {
    expect(await stopServer(1, files)).toBe(`stopped (pid ${hung.pid})`)
    await exited
  } finally {
    hung.kill("SIGKILL")
    rmSync(dir, { recursive: true })
  }
})
