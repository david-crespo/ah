// Setting tab titles from the session registry. Every tab's title is a pure function of the tree and
// the registry (title.ts), so whenever either changes, each tab's title is
// recomputed and set if it's not what was last set there. State changes
// are applied synchronously before this runs, so nothing needs a retry.
//
// Setting is a subprocess call (rex), so renders of one tab can overlap with
// changes arriving. Each tab has at most one set in flight; a change
// meanwhile marks the tab dirty, and when the set finishes it runs again from
// the latest state.
//
// Each snapshot has each tab's name, so a title someone else changed is seen
// and put back, once the last set has had REPAIR_MS to show up there. Rex
// sends window_label_changed, so a changed label shows up in the next
// snapshot.

import { type Snapshot, setWindowLabel, type Tab } from "../../host/rex.ts"
import type { Registry } from "../sessions/registry.ts"
import { tabTitle } from "./title.ts"

const REPAIR_MS = 5000

/** Rex refuses a window label longer than this, counted in code points */
const MAX_LABEL = 128

/** A tab's title cut to fit a label */
export function tabLabel(terminals: string[], registry: Registry): string | undefined {
  const title = tabTitle(terminals, registry)
  const chars = [...(title ?? "")]
  return chars.length > MAX_LABEL ? chars.slice(0, MAX_LABEL - 1).join("") + "…" : title
}

/** Sets a tab's title. `window` is the tab's snapshot window, the Rex
 * session the tab is in. */
type Setter = (window: string, tab: string, title: string) => Promise<"set" | "failed">

export class TitleSetter {
  #snapshot: Snapshot | null = null
  #registry: Registry | null = null
  /** Per tab: the title last set and when */
  #last = new Map<string, { title: string; at: number }>()
  #inFlight = new Set<string>()
  #dirty = new Set<string>()
  #set: Setter
  #now: () => number

  constructor(set: Setter = setWindowLabel, now = Date.now) {
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

  /** Each tab's title as ah has it and as Rex shows it */
  get tabs(): { tab: string; title: string | undefined; shown: string }[] {
    const registry = this.#registry
    if (!registry) return []
    return this.#tabs().map(({ tab: t }) => ({
      tab: t.id,
      title: tabLabel(
        t.terminals.map((x) => x.id),
        registry,
      ),
      shown: t.name,
    }))
  }

  #tabs(): { window: string; tab: Tab }[] {
    return (
      this.#snapshot?.windows.flatMap((w) =>
        w.tabs.map((tab) => ({ window: w.id, tab })),
      ) ?? []
    )
  }

  #update() {
    for (const { tab } of this.#tabs()) this.#render(tab.id)
  }

  #render(tabId: string) {
    if (this.#inFlight.has(tabId)) {
      this.#dirty.add(tabId)
      return
    }
    const found = this.#tabs().find((t) => t.tab.id === tabId)
    const registry = this.#registry
    if (!found || !registry || !found.tab.terminals.length) return
    const { window, tab } = found
    const title = tabLabel(
      tab.terminals.map((t) => t.id),
      registry,
    )
    // Nothing to say about this tab: leave whatever it has
    if (title === undefined) return
    const last = this.#last.get(tabId)
    const now = this.#now()
    const stale = tab.name !== title && (!last || now - last.at >= REPAIR_MS)
    if (last?.title === title && !stale) return
    this.#inFlight.add(tabId)
    this.#last.set(tabId, { title, at: now })
    void this.#set(window, tabId, title)
      .then((result) => {
        // Gone, or Rex refused: forget this one so the next render tries
        // again.
        if (result !== "set") this.#last.delete(tabId)
      })
      .finally(() => {
        this.#inFlight.delete(tabId)
        if (this.#dirty.delete(tabId)) this.#render(tabId)
      })
  }
}
