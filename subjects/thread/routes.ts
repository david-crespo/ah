// A thread's routes: `request` and `batch` under the page it belongs to, from the page,
// and `activity` under the files API (subjects/files/routes.ts), from the
// agent (through `ah message respond` and `pending`): GET for the requests and
// history, POST for a phase or reply.

import { InputError, parseActivity, parseBatch, parseRequest } from "./events.ts"
import type { Thread } from "./thread.ts"

/** `sub` is the path after the page's own; null if it isn't a thread route */
export async function threadRoute(
  req: Request,
  sub: string,
  thread: Thread,
): Promise<Response | null> {
  if (sub === "activity" && req.method === "GET") return Response.json(thread.state())
  if (!["request", "activity", "batch"].includes(sub) || req.method !== "POST") return null
  try {
    const body = await req.json()
    if (sub === "activity") {
      return Response.json({ activity: await thread.activity(parseActivity(body)) })
    }
    if (sub === "batch") {
      await thread.batch(parseBatch(body))
      return new Response(null, { status: 204 })
    }
    return Response.json(await thread.request(parseRequest(body, thread.kinds)))
  } catch (error) {
    if (error instanceof InputError) {
      return new Response(error.message + "\n", { status: error.status })
    }
    if (error instanceof SyntaxError) return new Response("Invalid JSON\n", { status: 400 })
    console.error("ah: could not save to the thread", error)
    return new Response("Could not save message. Retry when the server is available.\n", {
      status: 500,
    })
  }
}
