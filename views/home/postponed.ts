// Whether a waiting item is postponed, which both the server (a project's
// status, data.ts) and the page (client.ts) ask: its `until` is a time still
// to come. One that doesn't parse postpones nothing.

/** Postponed at `now` */
export function isPostponed(item: { until?: string }, now: Date): boolean {
  const until = item.until ? Date.parse(item.until) : NaN
  return until > +now
}
