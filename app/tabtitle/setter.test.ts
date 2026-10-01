import { expect, test } from "vitest"
import type { Snapshot } from "../dashboard/ghostty.ts"
import { apply, emptyRegistry, type Registry } from "../sessions/registry.ts"
import { TitleSetter } from "./setter.ts"

const snapshot = (name: string, terminals = ["t1"]): Snapshot => ({
  front: "w",
  windows: [
    {
      id: "w",
      selectedTab: "tab",
      tabs: [
        {
          id: "tab",
          name,
          focused: terminals[0],
          terminals: terminals.map((id) => ({ id, cwd: "/r/ah" })),
        },
      ],
    },
  ],
})

function registry(label: string): Registry {
  const r = emptyRegistry()
  apply(r, { kind: "shell", terminal: "t1", label })
  return r
}

/** A setter whose sets resolve when told to */
function fake() {
  const calls: string[] = []
  const pending: (() => void)[] = []
  let now = 0
  const setter = new TitleSetter(
    (_tab, _terminal, title) =>
      new Promise((resolve) => {
        calls.push(title)
        pending.push(() => resolve("set"))
      }),
    () => now,
  )
  // Finish every set, including ones a finishing set starts
  const flush = async () => {
    while (pending.length) {
      pending.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { setter, calls, flush, advance: (ms: number) => (now += ms) }
}

test("sets a tab's title when it changes, and not again when it doesn't", async () => {
  const { setter, calls, flush } = fake()
  setter.onSnapshot(snapshot("zsh"))
  setter.onRegistry(registry("ah"))
  await flush()
  setter.onSnapshot(snapshot("ah"))
  setter.onRegistry(registry("ah"))
  await flush()
  expect(calls).toEqual(["ah"])
})

test("a change during a set runs once more from the latest state", async () => {
  const { setter, calls, flush } = fake()
  setter.onSnapshot(snapshot("zsh"))
  setter.onRegistry(registry("a"))
  setter.onRegistry(registry("b"))
  setter.onRegistry(registry("c"))
  await flush()
  expect(calls).toEqual(["a", "c"])
})

test("a title changed from outside is put back once the last set has had time to show", async () => {
  const { setter, calls, flush, advance } = fake()
  setter.onSnapshot(snapshot("zsh"))
  setter.onRegistry(registry("ah"))
  await flush()
  // The poller hasn't caught up yet: not a repair
  setter.onSnapshot(snapshot("zsh"))
  await flush()
  expect(calls).toEqual(["ah"])
  advance(5000)
  setter.onSnapshot(snapshot("someone else's"))
  await flush()
  expect(calls).toEqual(["ah", "ah"])
})

test("leaves a tab alone when there's nothing to say about it", async () => {
  const { setter, calls, flush } = fake()
  setter.onSnapshot(snapshot("zsh", ["t9"]))
  setter.onRegistry(registry("ah"))
  await flush()
  expect(calls).toEqual([])
})

test("Ghostty's bell prefix doesn't count as the title changing", async () => {
  const { setter, calls, flush, advance } = fake()
  setter.onSnapshot(snapshot("zsh"))
  setter.onRegistry(registry("ah"))
  await flush()
  advance(5000)
  setter.onSnapshot(snapshot("🔔 ah"))
  await flush()
  expect(calls).toEqual(["ah"])
})
