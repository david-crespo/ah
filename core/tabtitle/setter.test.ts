import { expect, test } from "vitest"
import type { RexState } from "../model.ts"
import { apply, emptyRegistry, type Registry } from "../registry.ts"
import { TitleSetter } from "./setter.ts"

const rex = (name: string, blocks = ["t1"]): RexState => ({
  front: "w",
  sessions: [
    {
      id: "w",
      selectedTab: "tab",
      tabs: [
        {
          id: "tab",
          name,
          focused: blocks[0],
          blocks: blocks.map((id) => ({ id, cwd: "/r/ah" })),
        },
      ],
    },
  ],
})

function registry(label: string): Registry {
  const r = emptyRegistry()
  apply(r, { kind: "shell", block: "t1", label })
  return r
}

/** A setter whose sets resolve when told to */
function fake() {
  const calls: string[] = []
  const pending: (() => void)[] = []
  let now = 0
  const setter = new TitleSetter(
    (_window, _tab, title) =>
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
  setter.onRex(rex("zsh"))
  setter.onRegistry(registry("ah"))
  await flush()
  setter.onRex(rex("ah"))
  setter.onRegistry(registry("ah"))
  await flush()
  expect(calls).toEqual(["ah"])
})

test("a change during a set runs once more from the latest state", async () => {
  const { setter, calls, flush } = fake()
  setter.onRex(rex("zsh"))
  setter.onRegistry(registry("a"))
  setter.onRegistry(registry("b"))
  setter.onRegistry(registry("c"))
  await flush()
  expect(calls).toEqual(["a", "c"])
})

test("a title changed from outside is put back once the last set has had time to show", async () => {
  const { setter, calls, flush, advance } = fake()
  setter.onRex(rex("zsh"))
  setter.onRegistry(registry("ah"))
  await flush()
  // The poller hasn't caught up yet: not a repair
  setter.onRex(rex("zsh"))
  await flush()
  expect(calls).toEqual(["ah"])
  advance(5000)
  setter.onRex(rex("someone else's"))
  await flush()
  expect(calls).toEqual(["ah", "ah"])
})

test("leaves a tab alone when there's nothing to say about it", async () => {
  const { setter, calls, flush } = fake()
  setter.onRex(rex("zsh", ["t9"]))
  setter.onRegistry(registry("ah"))
  await flush()
  expect(calls).toEqual([])
})

test("a title too long for a Rex label is cut to fit, and then counts as set", async () => {
  const { setter, calls, flush, advance } = fake()
  const long = "é".repeat(200)
  setter.onRex(rex("zsh"))
  setter.onRegistry(registry(long))
  await flush()
  const cut = "é".repeat(127) + "…"
  expect(calls).toEqual([cut])
  advance(5000)
  setter.onRex(rex(cut))
  await flush()
  expect(calls).toEqual([cut])
})
