// Cases for findMoves (moves.ts): two versions of a file and the moves
// between them, each as the text it covers in the old version and the new,
// without blank lines. moves.test.ts checks them.

export type MoveCase = {
  name: string
  prev: string
  next: string
  moves: { from: string; to: string }[]
}

/** Paragraphs as blocks of a file */
const file = (...blocks: string[]) => `${blocks.join("\n\n")}\n`

const A =
  "The pane saves after you stop typing for a moment, so nothing is lost if the tab closes."
const B =
  "Comments go to the agent bound to the page, or wait for one if none is connected yet."
const C =
  "Run the server from source and it builds each bundle the first time a page asks for it."
const D =
  "Mermaid diagrams render in the preview, and a broken one shows its error in its place."
const E =
  "Keyboard shortcuts work in the editor pane too, unless the terminal has taken them first."

const how =
  "Note this repo isn't set up as a plugin, which has always seemed like too much machinery."
const howEdited = how.replace("too much", "unneeded")
const fence = "```sh\nnpm test\n```"
const movedEdited = A.replace("after you stop", "once you stop")

export const CASES: MoveCase[] = [
  {
    name: "finds nothing in an unchanged file",
    prev: file(A, B, C),
    next: file(A, B, C),
    moves: [],
  },
  {
    name: "finds a paragraph moved down",
    prev: file(A, B, C, D),
    next: file(B, C, A, D),
    moves: [{ from: A, to: A }],
  },
  {
    name: "finds a paragraph moved up",
    prev: file(A, B, C, D),
    next: file(A, D, B, C),
    moves: [{ from: D, to: D }],
  },
  {
    name: "of two blocks that swapped, takes the smaller one as moved",
    prev: file(A, "Short."),
    next: file("Short.", A),
    moves: [{ from: "Short.", to: "Short." }],
  },
  {
    name: "of two the same size, takes the earlier one as moved down",
    prev: file("One.", "Two.", "Six."),
    next: file("One.", "Six.", "Two."),
    moves: [{ from: "Two.", to: "Two." }],
  },
  {
    name: "finds a paragraph moved and lightly edited",
    prev: file(A, B, C, D),
    next: file(B, C, movedEdited, D),
    moves: [{ from: A, to: movedEdited }],
  },
  {
    name: "doesn't take a paragraph edited in place as moved",
    prev: file(A, B, C),
    next: file(A, B.replace("bound to", "that's bound to"), C),
    moves: [],
  },
  {
    name: "doesn't match a removed paragraph to an unrelated one added elsewhere",
    prev: file(A, B, C, D),
    next: file(A, C, D, E),
    moves: [],
  },
  {
    name: "doesn't take a copy added elsewhere as a move",
    prev: file(A, B, C),
    next: file(A, B, C, A),
    moves: [],
  },
  {
    name: "takes blocks that moved together as one move",
    prev: file("# Title", "## Use", A, B, D, "## Setup", C),
    next: file("# Title", "## Setup", C, "## Use", A, B, D),
    moves: [{ from: `## Setup\n${C}`, to: `## Setup\n${C}` }],
  },
  {
    name: "finds a heading moved on its own",
    prev: file("## Setup", A, B),
    next: file(A, B, "## Setup"),
    moves: [{ from: "## Setup", to: "## Setup" }],
  },
  {
    name: "doesn't match a short block to a different one",
    prev: file("## Setup", A, B),
    next: file(A, B, "## Install"),
    moves: [],
  },
  {
    name: "finds a code block moved",
    prev: file(fence, A, B),
    next: file(A, B, fence),
    moves: [{ from: fence, to: fence }],
  },
  {
    name: "finds a list item moved within its list",
    prev: `- ${A}\n- ${B}\n- ${C}\n- ${D}\n`,
    next: `- ${B}\n- ${C}\n- ${A}\n- ${D}\n`,
    moves: [{ from: `- ${A}`, to: `- ${A}` }],
  },
  {
    name: "finds a list item moved to another list",
    prev: `Intro.\n\n- ${A}\n- ${B}\n\n${D}\n\n- ${C}\n`,
    next: `Intro.\n\n- ${A}\n\n${D}\n\n- ${C}\n- ${B}\n`,
    moves: [{ from: `- ${B}`, to: `- ${B}` }],
  },
  {
    // As in a README where How to use moved above Caveats, with edits in both
    name: "finds a section moved above another and edited",
    prev: file(
      "## Caveats",
      A,
      `- ${B}\n- ${D}`,
      "## How to use",
      how,
      "- Give Claude a link.",
    ),
    next: file(
      "## How to use",
      howEdited,
      "- Give Claude a link.",
      "## Caveats",
      A,
      `- ${B.replace("yet", "now")}\n- ${D}`,
    ),
    moves: [
      {
        from: `## How to use\n${how}\n- Give Claude a link.`,
        to: `## How to use\n${howEdited}\n- Give Claude a link.`,
      },
    ],
  },
]
