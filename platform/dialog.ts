// Asking the person in a macOS dialog before ah does something only they may
// allow, like the stack page's push. ah's pages share one origin, so any
// page's script could ask for such a thing; a dialog the OS draws is one no
// page can click. Its text goes to osascript as arguments, never into the
// script's source, since it includes what a repo says, like commit
// descriptions.

import { run } from "./proc.ts"

/** The dialog's text, and the button that says yes next to Cancel */
export interface Question {
  text: string
  button: string
}

/** Whether the person clicked the question's button */
export type Confirm = (question: Question) => Promise<boolean>

// Unanswered for 2 minutes counts as Cancel, as does Escape
const SCRIPT = `on run argv
  set {theText, theButton} to argv
  activate
  try
    set answer to display dialog theText with title "ah" buttons {"Cancel", theButton} default button theButton cancel button "Cancel" with icon caution giving up after 120
  on error number -128
    return "Cancel"
  end try
  if gave up of answer then return "Cancel"
  return button returned of answer
end run`

/** osascript's arguments for `question`: the fixed script, then its text
 * after --, so text starting with - isn't taken for an option */
export const dialogArgs = ({ text, button }: Question) => ["-e", SCRIPT, "--", text, button]

export const confirmDialog: Confirm = async (question) => {
  const { success, stdout, stderr } = await run("osascript", dialogArgs(question))
  if (!success) console.error(`ah: couldn't show a dialog: ${stderr.trim()}`)
  return success && stdout.trim() === question.button
}
