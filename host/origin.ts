// Which requests each of the server's ports takes. The Host check blocks DNS
// rebinding. Origin keeps out other origins' pages, html pages on their own
// port included, and Sec-Fetch-Site catches what Origin misses: a no-cors GET
// from another origin carries no Origin, but says it's cross-origin. The CLI
// sends neither.

export interface GateHeaders {
  host: string | null
  origin: string | null
  /** Sec-Fetch-Site */
  site: string | null
}

export function requestGate(port: number): (headers: GateHeaders) => boolean {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  return ({ host, origin, site }) =>
    (!host || hosts.has(host)) &&
    (!origin || origins.has(origin)) &&
    // "none" is the user's own navigation: a typed URL, `open`, a bookmark
    (!site || site === "same-origin" || site === "none")
}

/** The headers the gate reads, from a fetch Request or a Node upgrade
 * request's headers */
export function gateHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): GateHeaders {
  const get = (name: string) => {
    const value = headers instanceof Headers ? headers.get(name) : headers[name]
    return typeof value === "string" ? value : null
  }
  return { host: get("host"), origin: get("origin"), site: get("sec-fetch-site") }
}
