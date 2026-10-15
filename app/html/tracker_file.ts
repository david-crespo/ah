// A tracker's file, which `ah app page open --tracker` writes from the template here:
// the page around the items, so an agent keeping a tracker only writes
// <ah-item>s into its groups (tracker.ts, tracker.css). One directory per
// tracker, since a page reloads on any change in its directory.

export const GROUPS = ["Needed", "Cleanup", "Unrelated"] as const

const escape = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  )

/** A new tracker with no items, its groups empty and hidden until they
 * have some */
export function trackerPage(title: string, goal: string): string {
  const groups = GROUPS.map((g) => `  <ah-group name="${g}">\n  </ah-group>`).join("\n")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/tracker.css">
<script type="module" src="/app/html/tracker.js"></script>
</head>
<body>
<main>
  <h1>${escape(title)}</h1>
  <p class="goal">${escape(goal)}</p>

  <!-- Each item, in the group it belongs to:
  <ah-item id="1" status="todo" rev="">
    <h3>Short title</h3>
    <p>Detail: what's wrong, what to change, file references, what was decided.</p>
  </ah-item>
  status: todo, doing, done, dropped, or hold. rev: the change ID, once there is one. -->
${groups}
</main>
</body>
</html>
`
}
