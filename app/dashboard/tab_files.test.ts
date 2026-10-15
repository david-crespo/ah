import { expect, test } from "vitest"
import type { Snapshot } from "../../host/rex.ts"
import { emptyRegistry, setFile } from "../sessions/registry.ts"
import { tabFiles } from "./tab_files.ts"

const snapshot: Snapshot = {
  front: "w",
  windows: [
    {
      id: "w",
      selectedTab: "a",
      tabs: [
        {
          id: "a",
          name: "",
          focused: "t2",
          terminals: [
            { id: "t1", cwd: "/r" },
            { id: "t2", cwd: "/r" },
            { id: "t3", cwd: "/r" },
          ],
        },
        { id: "b", name: "", focused: "t4", terminals: [{ id: "t4", cwd: "/r" }] },
        { id: "c", name: "", focused: "t5", terminals: [{ id: "t5", cwd: "/r" }] },
      ],
    },
  ],
}

test("each tab's file, if it's still there", () => {
  const r = emptyRegistry()
  setFile(r, "a", "/n/one.md")
  setFile(r, "c", "/n/gone.md")
  setFile(r, "closed", "/n/closed.md")
  const exists = (path: string) => path !== "/n/gone.md"
  expect(tabFiles(snapshot, new Set(["a", "b", "c"]), r, exists)).toEqual(
    new Map([["a", "/n/one.md"]]),
  )
  expect(tabFiles(snapshot, new Set(["b"]), r, exists)).toEqual(new Map())
})
