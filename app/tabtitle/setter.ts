// Setting Ghostty tab titles from the session registry, which is what
// ghostty-tab-title did. Every tab's title is a pure function of the tree and
// the registry (title.ts), so whenever either changes, each tab's title is
// recomputed and set if it's not what was last set there. No version tokens
// or retries: state changes are applied synchronously before this runs.
//
// Setting is an osascript call, so renders of one tab can overlap with
// changes arriving. Each tab has at most one set in flight; a change
// meanwhile marks the tab dirty, and when the set finishes it runs again from
// the latest state.
//
// The poller reads each tab's name, so a title someone else changed (or a
// Ghostty restart, which keeps tab ids but not titles set by an action) is
// seen and put back, once the last set has had REPAIR_MS to show up there.

import { type Snapshot, setTabTitle, type Tab } from "../dashboard/ghostty.ts"
import type { Registry } from "../sessions/registry.ts"
import { tabTitle } from "./title.ts"

const REPAIR_MS = 5000

/** A tab's title as set, from its name: Ghostty prefixes the name with 🔔
 * while a bell that rang in the tab hasn't been looked at */
export const shownTitle = (name: string) => name.replace(/^🔔 /, "")

type Setter = (
  tab: string,
  terminal: string,
  title: string,
) => ReturnType<typeof setTabTitle>

export class TitleSetter {
  #snapshot: Snapshot | null = null
  #registry: Registry | null = null
  /** Per tab: the title last set and when */
  #last = new Map<string, { title: string; at: number }>()
  #inFlight = new Set<string>()
  #dirty = new Set<string>()
  #set: Setter
  #now: () => number

  constructor(set: Setter = setTabTitle, now = Date.now) {
    this.#set = set
    this.#now = now
  }

  onSnapshot(snapshot: Snapshot) {
    this.#snapshot = snapshot
    this.#update()
  }

  onRegistry(registry: Registry) {
    this.#registry = registry
    this.#update()
  }

  /** Each tab's title as ah has it and as Ghostty shows it */
  get tabs(): { tab: string; title: string | undefined; shown: string }[] {
    const registry = this.#registry
    if (!registry) return []
    return this.#tabs().map((t) => ({
      tab: t.id,
      title: tabTitle(
        t.terminals.map((x) => x.id),
        registry,
      ),
      shown: shownTitle(t.name),
    }))
  }

  #tabs(): Tab[] {
    return this.#snapshot?.windows.flatMap((w) => w.tabs) ?? []
  }

  #update() {
    for (const tab of this.#tabs()) this.#render(tab.id)
  }

  #render(tabId: string) {
    if (this.#inFlight.has(tabId)) {
      this.#dirty.add(tabId)
      return
    }
    const tab = this.#tabs().find((t) => t.id === tabId)
    const registry = this.#registry
    if (!tab || !registry || !tab.terminals.length) return
    const title = tabTitle(
      tab.terminals.map((t) => t.id),
      registry,
    )
    // Nothing to say about this tab: leave whatever it has
    if (title === undefined) return
    const last = this.#last.get(tabId)
    const now = this.#now()
    const stale = shownTitle(tab.name) !== title && (!last || now - last.at >= REPAIR_MS)
    if (last?.title === title && !stale) return
    this.#inFlight.add(tabId)
    this.#last.set(tabId, { title, at: now })
    void this.#set(tabId, tab.terminals[0].id, title)
      .then((result) => {
        // Moved or gone: the next snapshot shows where things are now. Forget
        // this one so the next render tries again.
        if (result !== "set") this.#last.delete(tabId)
      })
      .finally(() => {
        this.#inFlight.delete(tabId)
        if (this.#dirty.delete(tabId)) this.#render(tabId)
      })
  }
}
