// Whether something is showing in a window: its connected pages, which
// still count as open for a few seconds after the last one goes, since a
// reload or a server restart drops the socket briefly. A new one counts as
// open for as long, so a window that's on its way gets the time to connect.

/** How long a window may be gone before it counts as closed */
export const GRACE_MS = 5000

export class Presence {
  #count = 0
  /** ms since the epoch: when the last page left, or when one was last
   * expected */
  #since: number

  constructor(now = Date.now()) {
    this.#since = now
  }

  get count(): number {
    return this.#count
  }

  /** How many pages are connected now */
  update(count: number, now = Date.now()) {
    if (this.#count && !count) this.#since = now
    this.#count = count
  }

  /** A page is on its way: give it the grace period again */
  expect(now = Date.now()) {
    if (!this.#count) this.#since = now
  }

  open(now = Date.now()): boolean {
    return this.#count > 0 || now - this.#since < GRACE_MS
  }
}
