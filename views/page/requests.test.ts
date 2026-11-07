import { expect, test } from "vitest"
import { InputError, parseRequest } from "../../subjects/thread/events.ts"
import { render } from "../../subjects/thread/thread.ts"
import { taskListKinds } from "./requests.ts"

const request = (input: object) => ({
  type: "request" as const,
  id: "r1",
  at: "",
  ...parseRequest(input, taskListKinds),
})

test("go takes no text, and the agent reads the item it's for", () => {
  const go = request({ kind: "go", text: "ignored", args: { item: "5", title: "Fix it" } })
  expect(go.text).toBeUndefined()
  expect(render(go, taskListKinds)).toEqual("Request r1: Go ahead with item 5: Fix it")
  expect(taskListKinds.go.feed?.(go)).toEqual({ label: "Go", body: "Item 5: Fix it" })
})

test("an item comment needs text and an item", () => {
  const comment = request({
    kind: "item-comment",
    text: "Why?",
    args: { item: "5", title: "Fix it" },
    replyTo: "r0",
  })
  expect(render(comment, taskListKinds)).toEqual(
    "Request r1, answering r0: a comment on item 5: Fix it\n\nWhy?",
  )
  expect(() => request({ kind: "item-comment", args: { item: "5" } })).toThrow(InputError)
  expect(() => request({ kind: "item-comment", text: "x", args: {} })).toThrow(InputError)
})
