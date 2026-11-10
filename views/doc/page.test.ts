import { expect, test } from "vitest"
import { indexPage, page } from "./page.ts"

// A markdown file can hold any HTML: a form posting to the API, or a <base>
// that moves where the page's own requests go
test("file pages forbid forms and <base>", () => {
  for (const html of [
    page("t", { editor: true, chat: true, path: "/p.md" }),
    indexPage([{ id: "x", name: "p.md" }]),
  ]) {
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]
    expect(csp).toMatch(/(^|; )form-action 'none'(;|$)/)
    expect(csp).toMatch(/(^|; )base-uri 'none'(;|$)/)
  }
})
