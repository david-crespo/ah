// skepsis, a diff review, hosted in the server under /view/skepsis/<id>/, on
// the API port: its own API reads the repo's files and sends to agents,
// which the pages port is there to keep agents' html pages from doing. The
// id is signed (subjects/id.ts) and holds the diff: the directory, the
// revisions, and the page whose agent gets the comments (app.ts), so there's no
// table of diffs to keep. Each diff's app (skepsis's createApp) is made on
// the first request for its id and kept among the 16 used last; a forgotten
// one's page keeps working, since its next request makes it again.

import { type App, type AppOptions, createApp } from "@oxide/skepsis"
import { redirect } from "../../platform/origin.ts"
import { payloadOf, signedId } from "../../subjects/id.ts"
import type { DiffSpec } from "./app.ts"

/** Apps kept */
const KEEP = 16

const notFound = () => new Response("not found", { status: 404 })

export class SkepsisView {
  #send: (spec: DiffSpec, text: string) => Promise<void>
  #create: (opts: AppOptions) => Promise<App>
  /** By id, the one used last at the end */
  #apps = new Map<string, Promise<App>>()

  /** `send` takes the comments a diff's Send button sends, and `create`
   * stands in for skepsis's in tests */
  constructor(
    send: (spec: DiffSpec, text: string) => Promise<void>,
    create: (opts: AppOptions) => Promise<App> = createApp,
  ) {
    this.#send = send
    this.#create = create
  }

  /** The path of the diff's page, /view/skepsis/<id>/. Makes its app, so a
   * bad revision rejects here, where the button can show it. */
  async open(spec: DiffSpec): Promise<string> {
    const id = signedId("skepsis", JSON.stringify(spec))
    await this.#app(id, spec)
    return `/view/skepsis/${id}/`
  }

  /** `rest` is the path after /view/skepsis/ */
  async handle(req: Request, rest: string): Promise<Response> {
    const m = rest.match(/^([^/]+)(\/?)(.*)$/)
    const spec = m && specOf(m[1])
    if (!m || !spec) return notFound()
    const [, id, slash, sub] = m
    // The page's URLs are relative to it
    if (!slash) return redirect(`/view/skepsis/${id}/`)
    let app: App
    try {
      app = await this.#app(id, spec)
    } catch (e) {
      return new Response((e as Error).message, { status: 502 })
    }
    const url = new URL(req.url)
    url.pathname = `/${sub}`
    const res = await app.fetch(new Request(url, req))
    // A copy, since a response's headers may not be changeable
    const framed = new Response(res.body, res)
    framed.headers.set("content-security-policy", "frame-ancestors 'none'")
    return framed
  }

  #app(id: string, spec: DiffSpec): Promise<App> {
    let app = this.#apps.get(id)
    this.#apps.delete(id)
    if (!app) {
      const { cwd, diff } = spec
      app = this.#create({
        cwd,
        vcs: "jj",
        ...("rev" in diff ? { revisions: diff.rev } : diff),
        send: (payload) => this.#send(spec, payload.prompt),
        guard: false,
      })
      // A diff that failed, perhaps for a revision that's there later, is
      // tried again next time
      app.catch(() => {
        if (this.#apps.get(id) === app) this.#apps.delete(id)
      })
    }
    this.#apps.set(id, app)
    for (const old of this.#apps.keys()) {
      if (this.#apps.size <= KEEP) break
      this.#apps.delete(old)
    }
    return app
  }
}

/** The diff `id` holds, if ah issued it */
function specOf(id: string): DiffSpec | null {
  const signed = payloadOf(id)
  if (signed?.slug !== "skepsis") return null
  try {
    return JSON.parse(signed.payload) as DiffSpec
  } catch {
    return null
  }
}
