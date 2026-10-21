#!/usr/bin/env node
// ah, the agent host: a local server for watching agent sessions and the
// views of files they show the user. The CLI has one group per noun in the
// model (`ah -h`). The code is in four layers, each using only the ones
// under it, and all of them the model's types (core/model.ts):
//
// - views/<name>/: a view's page and routes (/view/<name>/): the dashboard,
//   and the markdown and html subject types that serve a file's views. What
//   more than one view uses is at the top of views/ (the terminal theme,
//   GitHub's markdown styles) and in views/thread/ (the conversation panel
//   and selection popover).
// - core/: the agents, their registry, the tab titles they give Rex tabs,
//   and the tracker role (routes under /core/).
// - subjects/: the files open in views, the agent each is bound to
//   (subjects/files/), and each one's thread of requests to it
//   (subjects/thread/). Agents reach it through AgentDirectory, which core
//   implements.
// - platform/: starting and stopping the server, its ports, processes and
//   paths, and the adapters for Rex (rex.ts) and the harnesses' sessions
//   (session.ts).
//
// .oxlintrc.json enforces the order, tests aside.

import { Command } from "@commander-js/extra-typings"
import { serve as nodeServe } from "@hono/node-server"
import { readFile } from "node:fs/promises"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { dashboard, debugTabs } from "./views/dashboard/cli.ts"
import { Dashboard } from "./views/dashboard/routes.ts"
import { MarkdownBackend } from "./views/markdown/routes.ts"
import { HtmlBackend } from "./views/html/routes.ts"
import { request, tracker, view } from "./views/cli.ts"
import { debugAgents, workspace } from "./core/cli.ts"
import { hook } from "./core/hook.ts"
import { watchOpencode } from "./core/opencode.ts"
import { Core } from "./core/core.ts"
import { TitleSetter } from "./core/tabtitle/setter.ts"
import { assetPath } from "./platform/assets.ts"
import { boxCss } from "./views/dashboard/box.ts"
import { die, parseNumber, portOption } from "./platform/cli.ts"
import { handoff, takeHandoff } from "./subjects/files/cli.ts"
import { scrubSessionEnv } from "./platform/session.ts"
import { frameAncestors, gateHeaders, requestGate } from "./platform/origin.ts"
import { themeCss } from "./views/theme.ts"
import { FILE_KINDS, type RexState } from "./core/model.ts"
import {
  onRexHealth,
  type RexHealth,
  rexHealth,
  rexTrouble,
  watchRex,
} from "./platform/rex.ts"
import {
  ensureServer,
  defaultFiles,
  type Status,
  status,
  stopServer,
  waitForPages,
  writePidFile,
} from "./platform/server.ts"

/** "3h12m", "5m", "40s" */
function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)]
  return h ? `${h}h${m}m` : m ? `${m}m` : `${s}s`
}

/** `ah server status`'s lines on Rex */
function rexLines(rex: RexHealth): string[] {
  const ago = (at: number) => `${duration(Date.now() - at)} ago`
  const { connected, lastEventAt, reconnects } = rex.events
  const events = [connected ? "connected" : "not running"]
  if (lastEventAt !== null) events.push(`last event ${ago(lastEventAt)}`)
  if (reconnects)
    events.push(`${reconnects} ${reconnects === 1 ? "reconnect" : "reconnects"}`)
  const lines = [`rex events: ${events.join(", ")}`]
  if (rex.lastCall) {
    const { at, error } = rex.lastCall
    lines.push(`last rex call: ${ago(at)}, ${error === null ? "ok" : `failed: ${error}`}`)
  }
  if (rex.unrunnable) lines.push(rex.unrunnable)
  if (rex.binary !== "rex") lines.push(`rex: ${rex.binary} (the one on PATH was gone)`)
  return lines
}

interface ViewRoutes {
  /** `rest` is the path after /view/<name>/ */
  handle(req: Request, rest: string): Promise<Response>
  /** A WebSocket at `rest`: what to do with it once connected, or null if
   * there's nothing there */
  upgrade?(rest: string, query: URLSearchParams): ((ws: WebSocket) => void) | null
}

/** `snapshotDelayMs` null turns off snapshotting the focused workspace */
async function serve(port: number, snapshotDelayMs: number | null) {
  const startedAt = Date.now()
  scrubSessionEnv(process.env)
  const css = themeCss() + boxCss()
  // The stylesheet follows the OS theme, as the markdown pages do. The
  // dashboard is always dark, like the terminal, so its copy drops the light
  // theme.
  const markdownCss = await readFile(assetPath("views/github-markdown.min.css"), "utf8")
  const markdownDarkCss = markdownCss.replace(
    "@media (prefers-color-scheme:light)",
    "@media not all",
  )

  const chatCss = await readFile(assetPath("views/thread/chat.css"), "utf8")
  const taskListCss = await readFile(assetPath("views/html/task_list.css"), "utf8")

  // Agents' HTML pages run whatever scripts they include, so they get an
  // origin of their own, which this port refuses (views/html/routes.ts)
  const pagesPort = port + 1
  // The core: the agents, and where pages find the ones they're bound to
  const core = Core.load()
  const markdownBackend = new MarkdownBackend(port, core)
  const htmlBackend = new HtmlBackend(port, pagesPort, core, core.trackers)
  const dashboardBackend = new Dashboard({
    snapshotDelayMs,
    markdown: markdownBackend,
    html: htmlBackend,
    core,
  })
  const tabTitles = new TitleSetter()
  const routes = {
    dashboard: dashboardBackend,
    markdown: markdownBackend,
    html: htmlBackend,
  } satisfies Record<string, ViewRoutes>

  // One watcher for everything that follows the terminal, and one agent
  // registry. The core goes first: the others ask it about tabs (whose
  // workspace has which tracker). One that throws on a Rex update mustn't
  // keep it from the others, or take down the watcher.
  const onRex = (rex: RexState) => {
    for (const watcher of [core, dashboardBackend, tabTitles]) {
      try {
        watcher.onRex(rex)
      } catch (e) {
        console.error(`ah: ${watcher.constructor.name} failed on a Rex update:`, e)
      }
    }
  }
  void watchRex(onRex)
  onRexHealth(() => dashboardBackend.setRexTrouble(rexTrouble(rexHealth())))
  tabTitles.onRegistry(core.registry)
  core.subscribe((registry) => tabTitles.onRegistry(registry))
  // What windows show, so an agent hears when one it opened closes
  core.watchShowing(() => ({
    files: [...markdownBackend.files.list(), ...htmlBackend.files.list()].map((f) => ({
      path: f.path,
      agent: f.binding.agent,
      open: f.pages.presence.open(),
    })),
    dashboard: dashboardBackend.presence.open(),
  }))
  // An agent starting or going away: held comments go to whoever is there
  // now, and pages show whether anyone is
  core.subscribe(() => {
    markdownBackend.files.refresh()
    htmlBackend.files.refresh()
  })
  // opencode has no hooks: its service streams its sessions' events
  void watchOpencode(core)

  // Each view lives under /view/<name>/, with relative URLs inside it so
  // views can embed each other, and the host keeps /status and assets any
  // view may use at the root
  const viewRoute = (pathname: string) => {
    const m = pathname.match(/^\/view\/([^/]+)(\/.*)?$/)
    if (!m || !Object.hasOwn(routes, m[1])) return null
    const name = m[1] as keyof typeof routes
    const view: ViewRoutes = routes[name]
    return { name, view, rest: m[2] }
  }
  const pageRoute = (pathname: string) => pathname.match(/^\/view\/html\/(.*)$/)?.[1]

  const cssResponse = (text: string) =>
    new Response(text, { headers: { "content-type": "text/css; charset=utf-8" } })

  const handler = (req: Request) => {
    const { pathname } = new URL(req.url)
    if (pathname === "/")
      return Response.redirect(new URL("/view/dashboard/", req.url), 302)
    const inView = viewRoute(pathname)
    if (inView) {
      const { name, view, rest } = inView
      if (!rest) return Response.redirect(new URL(`/view/${name}/`, req.url), 302)
      return view.handle(req, rest.slice(1))
    }
    if (pathname.startsWith("/core/"))
      return core.handle(req, pathname.slice("/core/".length))
    if (pathname === "/tabtitles") return Response.json(tabTitles.tabs)
    if (pathname === "/status") {
      return Response.json({
        pid: process.pid,
        pages: dashboardBackend.pages,
        views: [...markdownBackend.files.list(), ...htmlBackend.files.list()].reduce(
          (n, f) => n + f.pages.locations.length,
          0,
        ),
        startedAt,
        rex: rexHealth(),
      } satisfies Status)
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
    const rest = pageRoute(pathname)
    if (rest !== undefined) return htmlBackend.handlePage(req, rest)
    if (pathname === "/chat.css") return cssResponse(chatCss)
    if (pathname === "/task_list.css") return cssResponse(taskListCss)
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
      const inView = viewRoute(pathname)
      return (inView?.rest && inView.view.upgrade?.(inView.rest.slice(1), query)) || null
    },
    () => {
      writePidFile(defaultFiles(), port)
      console.error(`ah: serving http://127.0.0.1:${port} (pid ${process.pid})`)
    },
  )
  listen(
    pagesPort,
    pagesHandler,
    (pathname, query) => {
      const rest = pageRoute(pathname)
      return rest === undefined ? null : htmlBackend.upgradePage(rest, query)
    },
    () => console.error(`ah: serving html pages on http://127.0.0.1:${pagesPort}`),
    port,
  )
}

const program = new Command("ah").description(
  "Agent host: a lightweight coordination layer around coding agents and the Rex " +
    "terminal. It lets agents spin up web UIs and message back and forth with them.",
)

const server = new Command("server").description(
  "Manage the local server that hosts pages and tracks agents",
)

server
  .command("start")
  .summary("Start the server in the background")
  .description("Start the server in the background. Does nothing if it's already running.")
  .addOption(portOption("Port to serve on"))
  .action(async ({ port }) => {
    const pid = await ensureServer(port)
    if (pid !== null) console.error(`ah: already running (pid ${pid})`)
  })

server
  .command("restart")
  .summary("Restart the server")
  .description("Stop the server and start it again, for example after editing ah.")
  .addOption(portOption("Port to serve on"))
  .action(async ({ port }) => {
    const pages = (await status(port))?.pages ?? 0
    // The new server would forget the open files and which sessions their
    // comments go to. They're carried over here, before pages reconnect, so
    // they find their files open.
    const open = await Promise.all(
      FILE_KINDS.map(async (kind) => ({ kind, requests: await handoff(kind, port) })),
    )
    console.error(`ah: ${await stopServer(port)}`)
    await ensureServer(port)
    let reopened = 0
    for (const { kind, requests } of open)
      reopened += await takeHandoff(kind, port, requests)
    if (reopened)
      console.error(
        `ah: carried over ${reopened} open ${reopened === 1 ? "file" : "files"}`,
      )
    // Until the pages open before reconnect, a command that shows something
    // would see none and open another window
    if (pages) console.error(`ah: ${await waitForPages(port, pages)}`)
  })

server
  .command("serve")
  .summary("Run the server in the foreground")
  .description(
    "Run the server in the foreground, logging to the terminal. `ah server start` runs this command in the background.",
  )
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
  .summary("Show whether the server is running")
  .description(
    "Show whether the server is running, with its pid, port, uptime, and log; how many pages show files; and whether it can follow Rex: the `rex events` stream, the last `rex` call, and which `rex` it runs.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    const s = await status(port)
    if (!s) return console.log(`not running on port ${port}`)
    const up = s.startedAt === null ? "" : `, up ${duration(Date.now() - s.startedAt)}`
    console.log(`running, pid ${s.pid}, port ${port}${up}`)
    if (s.views !== null)
      console.log(`${s.views} ${s.views === 1 ? "view" : "views"} connected`)
    if (s.rex) for (const line of rexLines(s.rex)) console.log(line)
    console.log(`log: ${defaultFiles().log}`)
  })

const debug = new Command("debug").description(
  "Inspect how ah sees Rex tabs and the agents in them",
)
debug.addCommand(debugTabs)
debug.addCommand(debugAgents)
for (const command of [view, request, tracker, workspace, dashboard, server, hook, debug])
  program.addCommand(command)

// `-h` is enough; no `help` subcommand, which isn't inherited, so at every
// level
const noHelpCommand = (c: Command) => {
  c.helpCommand(false)
  for (const sub of c.commands) noHelpCommand(sub as Command)
}
noHelpCommand(program)

await program.parseAsync()
