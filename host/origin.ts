// Which requests each of the server's ports takes. The Host check blocks DNS
// rebinding. Origin keeps out other origins' pages, html pages on their own
// port included, and Sec-Fetch-Site catches what Origin misses: a no-cors GET
// from another origin carries no Origin, but says it's cross-origin. The CLI
// sends neither.
//
// The pages port also takes the dashboard's frames of its pages. A frame
// load from the API port is same-site (ports don't count), the same as one
// from any other localhost app, so the gate lets in every same-site frame
// load and the pages' frame-ancestors keeps them out of anyone else's frames.

export interface GateHeaders {
  host: string | null
  origin: string | null
  /** Sec-Fetch-Site */
  site: string | null
  /** Sec-Fetch-Mode and Sec-Fetch-Dest */
  mode: string | null
  dest: string | null
}

const local = (port: number) => [`localhost:${port}`, `127.0.0.1:${port}`]

/** `framedBy` is the port of the pages that may frame this port's */
export function requestGate(
  port: number,
  { framedBy }: { framedBy?: number } = {},
): (headers: GateHeaders) => boolean {
  const hosts = new Set(local(port))
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  return ({ host, origin, site, mode, dest }) =>
    (!host || hosts.has(host)) &&
    (!origin || origins.has(origin)) &&
    // "none" is the user's own navigation: a typed URL, `open`, a bookmark
    (!site ||
      site === "same-origin" ||
      site === "none" ||
      (framedBy !== undefined &&
        site === "same-site" &&
        mode === "navigate" &&
        dest === "iframe"))
}

/** The CSP for every response on a port whose gate takes frames from
 * `framedBy`'s pages: only those, and its own, may frame it */
export const frameAncestors = (framedBy: number) =>
  `frame-ancestors 'self' ${local(framedBy)
    .map((h) => `http://${h}`)
    .join(" ")}`

/** The headers the gate reads, from a fetch Request or a Node upgrade
 * request's headers */
export function gateHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): GateHeaders {
  const get = (name: string) => {
    const value = headers instanceof Headers ? headers.get(name) : headers[name]
    return typeof value === "string" ? value : null
  }
  return {
    host: get("host"),
    origin: get("origin"),
    site: get("sec-fetch-site"),
    mode: get("sec-fetch-mode"),
    dest: get("sec-fetch-dest"),
  }
}
