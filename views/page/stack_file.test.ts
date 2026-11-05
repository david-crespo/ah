import { expect, test } from "vitest"
import { parseStackFile } from "./stack_data.ts"
import { stackJson, stackPage } from "./stack_file.ts"

test("a new stack's page loads the client, and its stack.json parses", () => {
  const page = stackPage("A <b> stack")
  expect(page).toContain("<title>A &lt;b&gt; stack</title>")
  expect(page).toContain('<script type="module" src="/view/page/stack.js">')
  expect(page).toContain('<link rel="stylesheet" href="/stack.css">')
  expect(parseStackFile(stackJson("A <b> stack"))).toEqual({
    title: "A <b> stack",
    notes: [],
    prs: [],
  })
})
