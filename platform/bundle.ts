// Views' client bundles, each served under its view as /view/<view>/<name>.
// Running from source, the server builds one with vite the first time it's
// asked for, so a restart picks up client edits; the published package ships
// them prebuilt in dist/client/<view>/ (scripts/build-client.ts).

import { readFile } from "node:fs/promises"
import type { FileKind } from "../core/model.ts"
import { assetPath } from "./assets.ts"

/** Each view's bundles: served name to entry point in views/<view>/. A view
 * is a file kind's, or the dashboard. */
export const bundles = {
  // bundle.js for a file's page, and preview.js with just the <ah-markdown>
  // element, for other pages that show a file. Either loads mermaid.js when a
  // file has a diagram.
  markdown: {
    "bundle.js": "client.ts",
    "preview.js": "preview.ts",
    "mermaid.js": "mermaid.ts",
  },
  html: { "chat.js": "client.ts", "task_list.js": "task_list.ts" },
  dashboard: { "client.js": "client.ts" },
} as const satisfies Record<FileKind | "dashboard", Record<string, string>>

export type ViewName = keyof typeof bundles

const fromSource = import.meta.filename.endsWith(".ts")

export async function buildClientBundle(view: ViewName, name: string): Promise<string> {
  if (!fromSource) return await readFile(assetPath(`dist/client/${view}/${name}`), "utf8")
  const files: Record<string, string> = bundles[view]
  const entry = Object.hasOwn(files, name) ? files[name] : undefined
  if (!entry) throw new Error(`no bundle ${name} in ${view}`)
  // vite is a dev dependency, left out of the published build
  const { build } = await import("vite")
  const result = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      lib: {
        entry: assetPath(`views/${view}/${entry}`),
        formats: ["es"],
        fileName: name.replace(/\.js$/, ""),
      },
      // One file per entry: @codemirror/language-data loads each language with
      // a dynamic import, which would otherwise make a chunk per language.
      // mermaid is too big to serve as is; the rest stay readable. Vite's own
      // minify option skips lib mode's es format.
      rolldownOptions: { output: { codeSplitting: false, minify: name === "mermaid.js" } },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  for (const { output } of outputs as { output: { type: string; code?: string }[] }[]) {
    const chunk = output.find((o) => o.type === "chunk")
    if (chunk?.code) return chunk.code
  }
  throw new Error(`vite produced no chunk for views/${view}/${entry}`)
}

/** Builds each bundle once, on first request or ahead of it, for one view's
 * routes */
export class ClientBundles {
  #view: ViewName
  #built = new Map<string, Promise<string>>()

  constructor(view: ViewName) {
    this.#view = view
  }

  has(name: string): boolean {
    return Object.hasOwn(bundles[this.#view], name)
  }

  get(name: string): Promise<string> {
    let bundle = this.#built.get(name)
    if (!bundle) {
      bundle = buildClientBundle(this.#view, name).catch((e) => {
        this.#built.delete(name) // retry on the next request
        throw e
      })
      this.#built.set(name, bundle)
    }
    return bundle
  }

  /** Building takes a second or two, so a page's bundle starts when the page
   * is opened, and the page's request for it waits */
  prebuild(name: string) {
    this.get(name).catch((e) => console.error(`ah: client bundle ${name} failed`, e))
  }

  /** The bundle as a response, or a 500 with the build error */
  async response(name: string): Promise<Response> {
    try {
      return new Response(await this.get(name), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      })
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  }
}
