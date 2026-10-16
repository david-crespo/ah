// Read-only LAN proxy for ah html pages, so a phone on the same network can
// see a tracker: GET only, only the named pages' files plus the shared
// tracker and chat assets, and no socket, so no live reload, comments or Go.
// ah itself listens on 127.0.0.1 and checks Host and Origin, so the proxy
// rewrites those.
//
// Usage: node lan-proxy.mjs <lan-ip> <page-id>...
// Page ids are the first column of `ah view ls` (e.g. index-f000374f).
import http from "node:http"

const [lanIp, ...pageIds] = process.argv.slice(2)
if (!lanIp || pageIds.length === 0) {
  console.error("usage: node lan-proxy.mjs <lan-ip> <page-id>...")
  process.exit(2)
}
const upstream = { host: "127.0.0.1", port: 7421 }
const listenPort = 7430

const allowed = (path) =>
  pageIds.some((id) => path.startsWith(`/view/html/${id}/`)) ||
  /^\/view\/html\/[\w.-]+\.(js|css)$/.test(path) ||
  /^\/[\w.-]+\.css$/.test(path)

http
  .createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname
    if (req.method !== "GET" || !allowed(path) || path.endsWith("/_ah/socket")) {
      res.writeHead(404).end()
      return
    }
    const headers = { ...req.headers, host: `${upstream.host}:${upstream.port}` }
    delete headers.origin
    delete headers.referer
    headers["sec-fetch-site"] = "same-origin"
    const up = http.request({ ...upstream, path: req.url, method: "GET", headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on("error", () => res.writeHead(502).end())
    up.end()
  })
  .listen(listenPort, lanIp, () => {
    for (const id of pageIds) console.log(`http://${lanIp}:${listenPort}/view/html/${id}/`)
  })
