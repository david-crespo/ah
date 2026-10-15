import { expect, test } from "vitest"
import { trackerPage } from "./tracker_file.ts"

test("the page has every group and the escaped title and goal", () => {
  const page = trackerPage("A <b> tracker", 'Ship "it" & more')
  expect(page).toContain("<title>A &lt;b&gt; tracker</title>")
  expect(page).toContain('<p class="goal">Ship &quot;it&quot; &amp; more</p>')
  for (const g of ["Needed", "Cleanup", "Unrelated"]) {
    expect(page).toContain(`<ah-group name="${g}">`)
  }
  expect(page).toContain('<script type="module" src="/app/html/tracker.js">')
})
