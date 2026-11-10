import { readFile } from "node:fs/promises"
import { expect, test } from "vitest"
import { assetPath } from "../../platform/assets.ts"

// It shows markdown files as the file page does (views/doc/page.ts), so it
// forbids the same: a form posting to the API, or a <base>
test("the dashboard forbids forms and <base>", async () => {
  const html = await readFile(assetPath("views/dashboard/page.html"), "utf8")
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1]
  expect(csp).toMatch(/(^|; )form-action 'none'(;|$)/)
  expect(csp).toMatch(/(^|; )base-uri 'none'(;|$)/)
})
