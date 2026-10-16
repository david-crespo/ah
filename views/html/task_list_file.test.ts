import { expect, test } from "vitest"
import { taskListPage } from "./task_list_file.ts"

test("the page has every group and the escaped title and goal", () => {
  const page = taskListPage("A <b> list", 'Ship "it" & more')
  expect(page).toContain("<title>A &lt;b&gt; list</title>")
  expect(page).toContain('<p class="goal">Ship &quot;it&quot; &amp; more</p>')
  for (const g of ["Needed", "Cleanup", "Unrelated"]) {
    expect(page).toContain(`<ah-group name="${g}">`)
  }
  expect(page).toContain('<script type="module" src="/view/html/task_list.js">')
})
