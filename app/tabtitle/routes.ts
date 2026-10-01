// The tabtitle app: the setter that keeps Ghostty's tab titles, and its
// routes, under /app/tabtitle/: each tab's title as ah has it and as Ghostty
// shows it, as JSON.

import type { Snapshot } from "../dashboard/ghostty.ts"
import type { Registry } from "../sessions/registry.ts"
import { TitleSetter } from "./setter.ts"

export class TabTitleApp {
  readonly setter = new TitleSetter()

  onSnapshot(snapshot: Snapshot) {
    this.setter.onSnapshot(snapshot)
  }

  onRegistry(registry: Registry) {
    this.setter.onRegistry(registry)
  }

  /** `rest` is the path after /app/tabtitle/ */
  async handle(_req: Request, rest: string): Promise<Response> {
    if (rest !== "") return new Response("not found", { status: 404 })
    return Response.json(this.setter.tabs)
  }
}
