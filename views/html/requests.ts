// The requests a task list's items send (task_list.ts), besides the chat
// panel's: Go, and a comment on an item

import type { RequestKinds } from "../../subjects/thread/events.ts"
import { threadKinds } from "../../subjects/thread/kinds.ts"

/** The item's id, and its title as the page shows it */
const item = { item: { required: true, max: 32 }, title: { max: 1000 } }

export const taskListKinds: RequestKinds = {
  go: {
    text: "none",
    args: item,
    render: ({ args }) => `Go ahead with item ${args.item}: ${args.title ?? ""}`,
    feed: ({ args }) => ({ label: "Go", body: `Item ${args.item}: ${args.title ?? ""}` }),
  },
  "item-comment": {
    text: "required",
    args: item,
    render: (r) => `a comment on item ${r.args.item}: ${r.args.title ?? ""}\n\n${r.text}`,
    feed: (r) => ({ label: `Comment on item ${r.args.item}`, body: r.text ?? "" }),
  },
}

/** What an HTML page takes: the chat panel's requests and a task list's */
export const htmlKinds: RequestKinds = { ...threadKinds, ...taskListKinds }
