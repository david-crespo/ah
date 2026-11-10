import { expect, test } from "vitest"
import { parseHomeFile } from "./data.ts"
import { homeJson, homePage } from "./file.ts"

test("a new home's page loads the client, and its home.json parses", () => {
  const page = homePage("A <b> home")
  expect(page).toContain("<title>A &lt;b&gt; home</title>")
  expect(page).toContain('<script type="module" src="/home.js">')
  expect(page).toContain('<link rel="stylesheet" href="/home.css">')
  expect(parseHomeFile(homeJson("A <b> home"))).toMatchObject({
    title: "A <b> home",
    projects: [],
    waiting: [],
    finished: [],
  })
})
