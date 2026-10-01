// A thread's routes, under the page it belongs to: `comment` from the page,
// and `activity` from the agent (through `ah app <name> respond` and `pending`): GET for
// the requests and history, POST for a phase or reply.

import { InputError, parseActivity, parseUser } from "./events.ts"
import type { Thread } from "./thread.ts"

/** `sub` is the path after the page's own; null if it isn't a thread route */
export async function threadRoute(
  req: Request,
  sub: string,
  thread: Thread,
): Promise<Response | null> {
  if (sub === "activity" && req.method === "GET") return Response.json(thread.state())
  if ((sub !== "comment" && sub !== "activity") || req.method !== "POST") return null
  try {
    const body = await req.json()
    if (sub === "activity") {
      return Response.json({ event: await thread.activity(parseActivity(body)) })
    }
    return Response.json(await thread.comment(parseUser(body)))
  } catch (error) {
    if (error instanceof InputError) {
      return new Response(error.message + "\n", { status: error.status })
    }
    if (error instanceof SyntaxError) return new Response("Invalid JSON\n", { status: 400 })
    console.error("ah: could not save conversation event", error)
    return new Response("Could not save message. Retry when the server is available.\n", {
      status: 500,
    })
  }
}
