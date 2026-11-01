import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { helixArgs } from "./helix_command.ts"

describe("helixArgs", () => {
  test("turns on auto-save with the flag where hx has it, keeping the user's config", async () => {
    const help = "    --auto-save <ms>    Save this terminal's buffers <ms> after an edit"
    expect(await helixArgs(help, "/notes.md")).toEqual(["--auto-save", "650", "/notes.md"])
  })

  test("turns on auto-save in a config of its own where hx has no flag for it", async () => {
    const args = await helixArgs("", "/notes.md")
    expect(args).toEqual(["--config", expect.any(String), "/notes.md"])
    expect(await readFile(args[1], "utf8")).toContain("[editor.auto-save")
  })
})
