// How a project's name in home.json is matched to one in workstreams.md, for
// the server (data.ts) and the page (client.ts) alike.

/** A project's name without a note in parentheses after it, so "ah (doc
 * editor, trackers)" in workstreams.md is the "ah" of home.json */
export const projectKey = (name: string) => name.replace(/\s*\(.*\)$/, "")
export const sameProject = (a: string, b: string) => projectKey(a) === projectKey(b)
