import { expect, test } from "vitest"
import { gateHeaders, requestGate } from "./origin.ts"

const api = requestGate(7420)
const headers = (more: Record<string, string>) =>
  gateHeaders(new Headers({ host: "127.0.0.1:7420", ...more }))

test("the API port takes its own pages and the CLI", () => {
  expect(api(headers({}))).toEqual(true)
  expect(
    api(headers({ origin: "http://127.0.0.1:7420", "sec-fetch-site": "same-origin" })),
  ).toEqual(true)
  expect(api(headers({ "sec-fetch-site": "none" }))).toEqual(true)
})

test("the API port refuses html pages, whatever the request", () => {
  // A fetch or WebSocket from an html page
  expect(api(headers({ origin: "http://127.0.0.1:7421" }))).toEqual(false)
  // A no-cors GET (an <img>, a <script>) carries no Origin; the port differs,
  // so it's same-site, not same-origin
  expect(api(headers({ "sec-fetch-site": "same-site" }))).toEqual(false)
  expect(api(headers({ "sec-fetch-site": "cross-site" }))).toEqual(false)
})

test("a Host other than the port's is refused, against DNS rebinding", () => {
  expect(api(gateHeaders({ host: "evil.example:7420" }))).toEqual(false)
  expect(api(gateHeaders({ host: "127.0.0.1:7421" }))).toEqual(false)
})
