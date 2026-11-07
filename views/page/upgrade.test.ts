import { expect, test } from "vitest"
import { pageScripts, retiredScript, retiredStub } from "./upgrade.ts"

const page = (src: string) =>
  `<main></main>\n<script type="module" src="${src}"></script>\n<p>/view/html/stack.js in prose</p>`

test("finds script tags on either old path", () => {
  expect(pageScripts.needs(page("/view/html/task_list.js"))).toEqual(true)
  expect(pageScripts.needs(page("/view/page/task_list.js"))).toEqual(true)
  for (const tag of [
    "<script src='/view/html/stack.js'></script>",
    '<script type="module" src = "/view/html/task_list.js"></script>',
    '<SCRIPT TYPE="module" SRC="/view/page/stack.js"></SCRIPT>',
    "<script type=module src=/view/html/task_list.js></script>",
  ])
    expect(pageScripts.needs(tag)).toEqual(true)
})

test("not current pages, other scripts, other tags or the path in prose", () => {
  expect(pageScripts.needs(page("/task_list.js"))).toEqual(false)
  expect(pageScripts.needs(page("/view/page/chat.js"))).toEqual(false)
  expect(pageScripts.needs('<div data-src="/view/html/task_list.js"></div>')).toEqual(false)
  expect(pageScripts.needs('<img src="/view/html/task_list.js">')).toEqual(false)
  expect(pageScripts.needs('<script src="/view/html/task_list.json"></script>')).toEqual(
    false,
  )
})

test("old paths serve the script with a banner", () => {
  expect(retiredScript("/view/html/stack.js")).toEqual("stack.js")
  expect(retiredScript("/view/page/task_list.js")).toEqual("task_list.js")
  expect(retiredScript("/view/page/chat.js")).toEqual(null)
  const stub = retiredStub("stack.js", "/view/html/stack.js")
  expect(stub.startsWith('import "/stack.js"\n')).toEqual(true)
  expect(stub).toContain("ah doctor")
})
