import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { HtmlBackend, inject } from "./routes.ts"

test("ah's tags go before the last </body>", () => {
  const html = '<body><script>const s = "</body>"</script></BODY >\n</html>'
  const out = inject(html, "dash-1a2b3c4d", { chat: true })
  const at = out.indexOf('<script type="module" src="/view/html/chat.js"')
  expect(at).toBeGreaterThan(out.indexOf('"</body>"'))
  expect(at).toBeLessThan(out.indexOf("</BODY >"))
  expect(out).toContain('data-ah-thread="/view/html/dash-1a2b3c4d/_ah/"')
  expect(out).toContain('<div id="popover">')
})

test("without </body>, at the end; with chat off, only the script", () => {
  const out = inject("<p>hi</p>", "p-00000000", { chat: false })
  expect(out.startsWith("<p>hi</p>\n<script")).toEqual(true)
  expect(out).toContain('data-ah-chat="off"')
  expect(out).not.toContain("popover")
  expect(out).not.toContain("/chat.css")
  expect(out).not.toContain("color-scheme")
})

test("in the dashboard, dark and see-through over the page's own style", () => {
  const out = inject("<p>hi</p>", "p-00000000", { chat: false, dashboard: true })
  expect(out).toContain("color-scheme: dark !important")
  expect(out).toContain("background: transparent !important")
})

describe("the API and pages ports", () => {
  let dir: string
  let backend: HtmlBackend
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ah-html-"))
    process.env.XDG_STATE_HOME = join(dir, "state")
    backend = new HtmlBackend(7420, 7421)
  })
  afterEach(async () => {
    for (const f of backend.files.list()) backend.files.close(f.id)
    delete process.env.XDG_STATE_HOME
    await rm(dir, { recursive: true })
  })

  // `rest` is the path alone, as the server passes it
  const rest = (path: string) => path.split("?")[0]
  const api = (path: string, init?: RequestInit) =>
    backend.handle(new Request(`http://127.0.0.1:7420/view/html/${path}`, init), rest(path))
  const pages = (path: string, init?: RequestInit) =>
    backend.handlePage(
      new Request(`http://127.0.0.1:7421/view/html/${path}`, init),
      rest(path),
    )

  async function open(name: string) {
    const path = join(dir, name)
    await writeFile(path, "<body><p>hi</p></body>")
    await writeFile(join(dir, "data.json"), "{}")
    const res = await api("files", {
      method: "POST",
      body: JSON.stringify({ path, address: null }),
    })
    return (await res.json()) as { id: string; url: string }
  }

  test("a page lives on the pages port, and the API port sends it there", async () => {
    const { id, url } = await open("report.html")
    expect(url).toEqual(`http://127.0.0.1:7421/view/html/${id}/`)
    const page = await pages(`${id}/`)
    expect(await page.text()).toContain("<p>hi</p>")
    expect((await pages(`${id}/data.json`)).status).toEqual(200)
    const redirect = await api(`${id}/data.json?x=1`)
    expect(redirect.status).toEqual(302)
    expect(redirect.headers.get("location")).toEqual(
      `http://127.0.0.1:7421/view/html/${id}/data.json?x=1`,
    )
  })

  test("the pages port has no files API, and the agent's activity stays on the API port", async () => {
    const { id } = await open("report.html")
    expect((await pages("files")).status).toEqual(404)
    expect((await pages("files", { method: "POST", body: "{}" })).status).toEqual(404)
    expect((await pages(`${id}/_ah/activity`)).status).toEqual(404)
    expect((await api(`${id}/_ah/activity`)).status).toEqual(200)
    // Requests come from the page itself
    const request = await pages(`${id}/_ah/request`, {
      method: "POST",
      body: JSON.stringify({ kind: "chat", text: "hello" }),
    })
    expect(request.status).toEqual(200)
  })

  test("the handoff gives the CLI each open file with its address, and pages nothing", async () => {
    await writeFile(join(dir, "report.html"), "<body></body>")
    const path = join(dir, "report.html")
    const address = { harness: "claude", socket: "/tmp/1.sock", token: "secret" }
    await api("files", { method: "POST", body: JSON.stringify({ path, address }) })
    expect(await (await api("files/handoff")).json()).toEqual([
      { path, address, agentId: null },
    ])
    const fromPage = { headers: { "sec-fetch-site": "same-origin" } }
    expect((await api("files/handoff", fromPage)).status).toEqual(403)
    const withOrigin = { headers: { origin: "http://127.0.0.1:7420" } }
    expect((await api("files/handoff", withOrigin)).status).toEqual(403)
    expect((await pages("files/handoff")).status).toEqual(404)
  })
})
