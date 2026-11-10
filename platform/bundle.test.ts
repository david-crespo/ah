import { afterEach, expect, test } from "vitest"
import { buildClientBundle } from "./bundle.ts"

const nodeEnv = process.env.NODE_ENV
afterEach(() => {
  process.env.NODE_ENV = nodeEnv
})

test("building a bundle leaves the server's NODE_ENV as it started", async () => {
  // vite sets it to production when it's unset
  delete process.env.NODE_ENV
  await buildClientBundle("dashboard", "client.js")
  expect(process.env.NODE_ENV).toBe(nodeEnv)
})
