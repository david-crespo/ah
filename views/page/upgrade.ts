// The scripts pages in people's repos load, at fixed paths on the pages
// port that don't follow ah's folder names, and the paths they used to load
// them from. A page on an old path gets the script anyway, with a banner
// saying it's old, and `ah doctor` lists it (pageScripts).

import type { FileUpgrade } from "../../core/upgrades.ts"

/** Served at /<name> on the pages port */
export const PUBLIC_SCRIPTS = ["task_list.js", "stack.js"]

/** Where pages loaded them from: views/html/ until the views were renamed
 * doc and page, then views/page/ */
const OLD_SRC =
  /<script\b[^>]*?\ssrc\s*=\s*["']?\/view\/(?:html|page)\/(?:task_list|stack)\.js(?=["'\s>])/i

/** For a path a page used to load a script from, the script's name */
export function retiredScript(pathname: string): string | null {
  return pathname.match(/^\/view\/(?:html|page)\/(task_list\.js|stack\.js)$/)?.[1] ?? null
}

/** What a retired path serves: the script, and a banner on the page */
export function retiredStub(name: string, pathname: string): string {
  const text = `An ah update moved this page's script from ${pathname} to /${name}. The page still works; to update it, ask an agent in this repo to run ah doctor.`
  return `import "/${name}"
const note = document.createElement("div")
note.textContent = ${JSON.stringify(text)}
note.style.cssText = "position: sticky; top: 0; z-index: 8; padding: 6px 16px; font: 13px -apple-system, sans-serif; background: #9a6700; color: #fff"
document.body.prepend(note)
`
}

export const pageScripts: FileUpgrade = {
  what: "Load task_list.js and stack.js from /task_list.js and /stack.js",
  needs: (text) => OLD_SRC.test(text),
  how: "In the script tag that loads task_list.js or stack.js, change the src from /view/html/<name>.js or /view/page/<name>.js to /<name>.js. Nothing else on the page changes.",
}
