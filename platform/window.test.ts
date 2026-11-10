import { expect, test, vi } from "vitest"

// Every command fails, and nothing opens or builds for real
vi.mock("./proc.ts", () => ({
  run: async () => ({ success: false, code: 1, stdout: "", stderr: "it failed" }),
  processTable: () => [],
}))
vi.mock("./focus.ts", () => ({ focusHere: async () => ({ take: true, front: null }) }))
// No app built yet, so a window builds it
vi.mock("./assets.ts", () => ({ assetPath: (path: string) => `/nonexistent/${path}` }))

const { showUrl } = await import("./window.ts")

const options = { name: "x", badge: "X", color: "#000000" }

test("a failed build of the window app rejects, for the caller to report", async () => {
  await expect(showUrl("window", "http://127.0.0.1:1/", options)).rejects.toThrow(
    "couldn't build the window app:\nit failed",
  )
})

test("a tab that fails to open rejects", async () => {
  await expect(showUrl("tab", "http://127.0.0.1:1/", options)).rejects.toThrow("it failed")
})
