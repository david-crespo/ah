// The requests every thread takes: messages from the conversation panel, and
// comments and de-LLM requests on a selection

import type { Request } from "../../model.ts"
import type { RequestKinds } from "./events.ts"

const quote = (text: string) => JSON.stringify(text)

/** The selected passage, with the text around it to tell repeats apart */
function passage({ args }: Request): string {
  const around = [
    args.prefix && `after ${quote(args.prefix)}`,
    args.suffix && `before ${quote(args.suffix)}`,
  ].filter(Boolean)
  const embed = args.embed ? ` in the embed of ${args.embed}` : ""
  return `the passage ${quote(args.selection)}${embed}${around.length ? ` (${around.join(", ")})` : ""}`
}

/** The selection as rendered on the page, up to 60 characters on each side
 * of it, and the URL of the embed it's in, if any */
const selection = {
  selection: { required: true },
  prefix: {},
  suffix: {},
  embed: { max: 4000 },
}

export const threadKinds: RequestKinds = {
  // `about` is what the page says the user is looking at (a page sets
  // data-ah-about on its <html>), such as the item selected in a list
  chat: {
    text: "required",
    args: { about: { max: 1000 } },
    render: (r) =>
      r.args.about ? `(on the page, about ${r.args.about})\n${r.text}` : r.text!,
    feed: (r) => ({
      ...(r.args.about && { label: `About ${r.args.about}` }),
      body: r.text ?? "",
    }),
  },
  comment: {
    text: "required",
    args: selection,
    render: (r) => `a comment on ${passage(r)}:\n${r.text}`,
    feed: (r) => ({ label: "Selection comment", body: r.text ?? "" }),
  },
  dellm: {
    text: "optional",
    args: selection,
    render: (r) =>
      `de-LLM ${passage(r)}: rewrite it to sound like a person` +
      (r.text ? `. Guidance: ${r.text}` : ""),
    feed: (r) => ({
      label: "Selection comment",
      body: r.text || "Rewrite this passage to sound like a person.",
    }),
  },
}
