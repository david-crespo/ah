#!/usr/bin/env node
// ah, the agent host: a local server and the apps it hosts for watching agent
// sessions. The layout mirrors the CLI and the routes: app/<name>/ holds an
// app's commands (cli.ts, `ah app <name>`) and its routes (routes.ts,
// /app/<name>/), and host/ holds what isn't any one app's: starting and
// stopping the server, the terminal theme, posting to sessions, and the
// chat layer (host/chat/: a page's thread with its session). The page app's
// commands serve files from two backends with routes of their own,
// app/markdown/ and app/html/.
//
//   ah server start             start the server on 127.0.0.1:7420 (and 7421
//                               for html pages) in the background; commands
//                               that need it start it too
//   ah server stop, restart     stop it, or restart it to pick up edits to ah
//                               (host/server.ts)
//   ah server serve             the server itself, in the foreground: what
//                               start runs, logging to a file
//   ah server status            whether a dashboard page is open, for agents
//                               deciding where to show things
//   ah hook agent|shell         what agent hooks and zsh run to report
//                               sessions and directories (app/sessions/hook.ts)
//   ah app                      list the apps
//   ah app <name> open --in     open an app's view in some place: the dashboard
//                               in a Chrome app window, a page in a browser
//                               tab, the dashboard, or glow
//   ah app page open            a markdown or HTML file an agent wrote, live
//                               reloaded, with a conversation back to the agent
//   ah app sessions ls          agent sessions (Claude, Codex) and their terminals
//   ah debug tabs               print what ah sees of Rex, once, with each
//                               tab's title vs the one ah computes; the
//                               server keeps them set (app/tabtitle/)

import { Command } from "@commander-js/extra-typings"
import { serve as nodeServe } from "@hono/node-server"
import { readFile } from "node:fs/promises"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { dashboard } from "./app/dashboard/cli.ts"
import { agentFile, dashboardStatus } from "./app/dashboard/api.ts"
import { Dashboard } from "./app/dashboard/routes.ts"
import { MarkdownApp } from "./app/markdown/routes.ts"
import { HtmlApp } from "./app/html/routes.ts"
import { page, pageBackends } from "./app/page/cli.ts"
import { sessions } from "./app/sessions/cli.ts"
import { hook } from "./app/sessions/hook.ts"
import { watchOpencode } from "./app/sessions/opencode.ts"
import { SessionsApp } from "./app/sessions/routes.ts"
import { TabTitleApp } from "./app/tabtitle/routes.ts"
import { assetPath } from "./host/assets.ts"
import { boxCss } from "./host/box.ts"
import { die, parseNumber, portOption } from "./host/cli.ts"
import { handoff, takeHandoff } from "./host/files/cli.ts"
import { currentAgent, scrubSessionEnv } from "./host/session.ts"
import { debug } from "./host/debug.ts"
import { frameAncestors, gateHeaders, requestGate } from "./host/origin.ts"
import { themeCss } from "./host/theme.ts"
import { type Snapshot, watchRex } from "./host/rex.ts"
import {
  ensureServer,
  defaultFiles,
  type Status,
  status,
  stopServer,
  waitForPages,
  writePidFile,
} from "./host/server.ts"

// Each app has its own verbs, and `open` shows one of its views in a place
// given by --in. Each view decides how to draw itself there, so a place can
// gain a view (a markdown file in the dashboard, the dashboard in a split)
// without the command changing. Each view's --in only accepts the places it
// supports so far.
const apps = { dashboard, page, sessions }

interface AppRoutes {
  /** `rest` is the path after /app/<name>/ */
  handle(req: Request, rest: string): Promise<Response>
  /** A WebSocket at `rest`: what to do with it once connected, or null if
   * there's nothing there */
  upgrade?(rest: string, query: URLSearchParams): ((ws: WebSocket) => void) | null
}

/** `snapshotDelayMs` null turns off snapshotting the focused workspace */
async function serve(port: number, snapshotDelayMs: number | null) {
  scrubSessionEnv(process.env)
  const css = themeCss() + boxCss()
  // The stylesheet follows the OS theme, as the markdown app's pages do. The
  // dashboard is always dark, like the terminal, so its copy drops the light
  // theme.
  const markdownCss = await readFile(assetPath("host/github-markdown.min.css"), "utf8")
  const markdownDarkCss = markdownCss.replace(
    "@media (prefers-color-scheme:light)",
    "@media not all",
  )

  const chatCss = await readFile(assetPath("host/chat/chat.css"), "utf8")
  const trackerCss = await readFile(assetPath("app/html/tracker.css"), "utf8")

  // Agents' HTML pages run whatever scripts they include, so they get an
  // origin of their own, which this port refuses (app/html/routes.ts)
  const pagesPort = port + 1
  // The session registry is also where pages find the agents they're bound
  // to
  const sessionsApp = SessionsApp.load()
  const markdownApp = new MarkdownApp(port, sessionsApp)
  const htmlApp = new HtmlApp(port, pagesPort, sessionsApp)
  const dashboardApp = new Dashboard({
    snapshotDelayMs,
    markdown: markdownApp,
    html: htmlApp,
    sessions: sessionsApp,
  })
  const tabtitleApp = new TabTitleApp()
  const routes = {
    dashboard: dashboardApp,
    markdown: markdownApp,
    html: htmlApp,
    sessions: sessionsApp,
    tabtitle: tabtitleApp,
  } satisfies Record<string, AppRoutes>

  // One watcher for every app that follows the terminal, and one session
  // registry. An app
  // that throws on a snapshot mustn't keep it from the others, or take down
  // the watcher.
  const onSnapshot = (snapshot: Snapshot) => {
    for (const app of [dashboardApp, sessionsApp, tabtitleApp]) {
      try {
        app.onSnapshot(snapshot)
      } catch (e) {
        console.error(`ah: ${app.constructor.name} failed on a snapshot:`, e)
      }
    }
  }
  void watchRex(onSnapshot)
  tabtitleApp.onRegistry(sessionsApp.registry)
  sessionsApp.subscribe((registry) => tabtitleApp.onRegistry(registry))
  // An agent starting or going away: held comments go to whoever is there
  // now, and pages show whether anyone is
  sessionsApp.subscribe(() => {
    markdownApp.files.refresh()
    htmlApp.files.refresh()
  })
  // opencode has no hooks: its service streams its sessions' events
  void watchOpencode(sessionsApp)

  // Routes mirror the CLI, but for the page app's backends: each lives under
  // /app/<name>/, with relative URLs inside it so apps can embed each
  // other's views, and the host keeps /status and assets any app may use at
  // the root
  const appRoute = (pathname: string) => {
    const m = pathname.match(/^\/app\/([^/]+)(\/.*)?$/)
    if (!m || !Object.hasOwn(routes, m[1])) return null
    const name = m[1] as keyof typeof routes
    const app: AppRoutes = routes[name]
    return { name, app, rest: m[2] }
  }

  const cssResponse = (text: string) =>
    new Response(text, { headers: { "content-type": "text/css; charset=utf-8" } })

  const handler = (req: Request) => {
    const { pathname } = new URL(req.url)
    if (pathname === "/") return Response.redirect(new URL("/app/dashboard/", req.url), 302)
    const inApp = appRoute(pathname)
    if (inApp) {
      const { name, app, rest } = inApp
      if (!rest) return Response.redirect(new URL(`/app/${name}/`, req.url), 302)
      return app.handle(req, rest.slice(1))
    }
    if (pathname === "/status") {
      return Response.json({ pid: process.pid, pages: dashboardApp.pages } satisfies Status)
    }
    if (pathname === "/github-markdown.css") return cssResponse(markdownCss)
    if (pathname === "/github-markdown-dark.css") return cssResponse(markdownDarkCss)
    if (pathname === "/chat.css") return cssResponse(chatCss)
    if (pathname === "/theme.css") return cssResponse(css)
    return new Response("not found", { status: 404 })
  }

  // The pages port has only what html pages load
  const pagesRoutes = (req: Request) => {
    const { pathname } = new URL(req.url)
    const m = pathname.match(/^\/app\/html\/(.*)$/)
    if (m) return htmlApp.handlePage(req, m[1])
    if (pathname === "/chat.css") return cssResponse(chatCss)
    if (pathname === "/tracker.css") return cssResponse(trackerCss)
    return new Response("not found", { status: 404 })
  }
  // The dashboard frames them (its gate takes those loads), and nothing else may
  const pagesHandler = async (req: Request) => {
    const res = await pagesRoutes(req)
    // A copy, since a redirect's headers can't be changed
    const framed = new Response(res.body, res)
    framed.headers.set("content-security-policy", frameAncestors(port))
    return framed
  }

  const sockets = new WebSocketServer({ noServer: true })
  const refuse = (socket: Duplex, status: string) => {
    // Nothing else listens on a socket the server hands over for an upgrade,
    // so a client resetting it, as a page reconnecting to a file a restart
    // forgot can, would crash the server
    socket.on("error", () => {})
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  }

  /** Serve one port, taking only the requests its gate allows */
  const listen = (
    p: number,
    fetch: (req: Request) => Response | Promise<Response>,
    upgrade: (pathname: string, query: URLSearchParams) => ((ws: WebSocket) => void) | null,
    onListening: () => void,
    framedBy?: number,
  ) => {
    const allowed = requestGate(p, { framedBy })
    const gated = (req: Request) =>
      allowed(gateHeaders(req.headers))
        ? fetch(req)
        : new Response("forbidden", { status: 403 })
    const server = nodeServe({ fetch: gated, port: p, hostname: "127.0.0.1" }, onListening)
    server.on("upgrade", (req, socket, head) => {
      if (!allowed(gateHeaders(req.headers))) return refuse(socket, "403 Forbidden")
      const { pathname, searchParams } = new URL(req.url ?? "/", "http://127.0.0.1")
      const accept = upgrade(pathname, searchParams)
      if (!accept) return refuse(socket, "404 Not Found")
      sockets.handleUpgrade(req, socket, head, accept)
    })
    server.on("error", async (e: NodeJS.ErrnoException) => {
      // Two commands starting the server at once: the other one won
      if (e.code !== "EADDRINUSE") throw e
      die(`ah: port ${p} is in use${(await status(port)) ? " by another ah server" : ""}`)
    })
  }

  listen(
    port,
    handler,
    (pathname, query) => {
      const inApp = appRoute(pathname)
      return (inApp?.rest && inApp.app.upgrade?.(inApp.rest.slice(1), query)) || null
    },
    () => {
      writePidFile(defaultFiles(), port)
      console.error(`ah: serving http://127.0.0.1:${port} (pid ${process.pid})`)
    },
  )
  listen(
    pagesPort,
    pagesHandler,
    (pathname) => {
      const m = pathname.match(/^\/app\/html\/(.*)$/)
      return m ? htmlApp.upgradePage(m[1]) : null
    },
    () => console.error(`ah: serving html pages on http://127.0.0.1:${pagesPort}`),
    port,
  )
}

const app = new Command("app")
  .description("Apps the server hosts, each with its own verbs; alone, lists them")
  .action(function () {
    for (const c of this.commands) console.log(`${c.name()}\t${c.description()}`)
  })
for (const command of Object.values(apps)) app.addCommand(command)

const program = new Command("ah").description(
  "Agent host: the server and the apps it hosts for watching agent sessions",
)

const server = new Command("server").description(
  "The local server the apps run in: start, stop, restart, or run it",
)

server
  .command("start")
  .description("Start the server in the background, unless it's running")
  .addOption(portOption("Port to serve on"))
  .action(async ({ port }) => {
    const pid = await ensureServer(port)
    if (pid !== null) console.error(`ah: already running (pid ${pid})`)
  })

server
  .command("restart")
  .description("Stop the server and start it again, e.g. after editing ah")
  .addOption(portOption("Port to serve on"))
  .action(async ({ port }) => {
    const pages = (await status(port))?.pages ?? 0
    // The new server would forget the open files and which sessions their
    // comments go to. They're carried over here, in memory, since the
    // sessions' tokens mustn't go on disk, and before pages reconnect, so
    // they find their files open.
    const open = await Promise.all(
      pageBackends.map(async (name) => ({ name, requests: await handoff(name, port) })),
    )
    console.error(`ah: ${await stopServer(port)}`)
    await ensureServer(port)
    let reopened = 0
    for (const { name, requests } of open)
      reopened += await takeHandoff(name, port, requests)
    if (reopened)
      console.error(`ah: reopened ${reopened} ${reopened === 1 ? "file" : "files"}`)
    // Until the pages open before reconnect, a command that shows something
    // would see none and open another window
    if (pages) console.error(`ah: ${await waitForPages(port, pages)}`)
  })

server
  .command("serve")
  .description("Run the server in the foreground, logging to the terminal; start runs this")
  .addOption(portOption("Port to serve on"))
  .option(
    "--snapshot-delay <seconds>",
    "Snapshot the focused workspace once its files have been quiet this long",
    parseNumber,
    2,
  )
  .option("--no-snapshot", "Never snapshot; @ only updates when some jj command runs")
  .action(async ({ port, snapshot, snapshotDelay }) => {
    await serve(port, snapshot ? snapshotDelay * 1000 : null)
  })

server
  .command("stop")
  .description("Stop the server")
  .addOption(portOption())
  .action(async ({ port }) => {
    console.log(`ah: ${await stopServer(port)}`)
  })

server
  .command("status")
  .description("Whether a dashboard page is open, and this session's file in it")
  .addOption(portOption())
  .action(async ({ port }) => {
    console.log(await dashboardStatus(port))
    const agent = currentAgent()
    const file = agent && (await agentFile(port, agent))
    if (file) console.log(`in the dashboard: ${file}`)
  })

program.addCommand(server)
program.addCommand(hook)
program.addCommand(app)
program.addCommand(debug)

await program.parseAsync()
