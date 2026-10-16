// Conflict markers left in a markdown file by jj or git, parsed into the
// sides they describe so the preview can render each side as markdown
// instead of showing a wall of `<<<<<<<` and `+++++++` lines.
//
// Recognised formats (marker length is 7 or more, matching jj's habit of
// growing markers when the content contains marker-like lines):
//
//   jj "diff" (default)      jj "snapshot"              git / jj "git" / diff3
//   <<<<<<< Conflict 1 of 1  <<<<<<< Conflict 1 of 1    <<<<<<< HEAD
//   %%%%%%% Changes from …   +++++++ Contents of side 1  side 1 text
//   -base line               side 1 text                ||||||| Base
//   +side 1 line             ------- Contents of base    base text
//   +++++++ Contents of …    base text                   =======
//   side 2 text              +++++++ Contents of side 2  side 2 text
//   >>>>>>> Conflict 1 of 1  side 2 text                >>>>>>> feature
//                            >>>>>>> Conflict 1 of 1 ends

export type Panel = {
  kind: "side" | "base"
  label: string
  /** Full text of this version of the region. */
  text: string
  /**
   * Lines the jj "diff" format marked as added (side) or removed (base).
   * Absent when the format gave the version as a snapshot.
   */
  changed?: string[]
}

export type Conflict = {
  title: string
  panels: Panel[]
}

const OPEN = /^(<{7,})(?: (.*))?$/
const marker = (ch: string, n: number) => new RegExp(`^\\${ch}{${n}}(?: (.*))?$`)

/** Index of the line closing a conflict opened at `start`, or -1. */
export function findConflictEnd(lines: string[], start: number): number {
  const open = OPEN.exec(lines[start])
  if (!open) return -1
  const close = marker(">", open[1].length)
  for (let i = start + 1; i < lines.length; i++) {
    if (close.test(lines[i])) return i
  }
  return -1
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// "Changes from base to side #1" / "Contents of side #2" -> "Side #1"
function sideLabel(header: string | undefined, fallback: string) {
  if (!header) return fallback
  const m = /(?:changes from base to|contents of)\s+(.*)$/i.exec(header)
  return capitalize(m ? m[1] : header)
}

/** Parse lines[start..=end], where end came from findConflictEnd. */
export function parseConflict(lines: string[], start: number, end: number): Conflict {
  const open = OPEN.exec(lines[start])!
  const n = open[1].length
  const closeText = marker(">", n).exec(lines[end])?.[1]
  const headers: [RegExp, "diff" | "side" | "base" | "gitbase" | "gitsep"][] = [
    [marker("%", n), "diff"],
    [marker("+", n), "side"],
    [marker("-", n), "base"],
    [marker("|", n), "gitbase"],
    [marker("=", n), "gitsep"],
  ]
  type Section = {
    kind: (typeof headers)[number][1] | "first"
    header?: string
    lines: string[]
  }
  const sections: Section[] = [{ kind: "first", lines: [] }]
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    const hit = headers.find(([re]) => re.test(line))
    if (hit) {
      sections.push({ kind: hit[1], header: hit[0].exec(line)![1], lines: [] })
    } else {
      sections[sections.length - 1].lines.push(line)
    }
  }
  // jj formats open straight into a header; git style has side 1 first
  // (possibly empty, when that side deleted the region).
  const jjStyle = ["diff", "side", "base"].includes(sections[1]?.kind ?? "")
  if (jjStyle && sections[0].lines.length === 0) sections.shift()

  const panels: Panel[] = []
  let sideNo = 0
  for (const s of sections) {
    const text = s.lines.join("\n")
    switch (s.kind) {
      case "first":
        panels.push({ kind: "side", label: open[2] || `Side #${++sideNo}`, text })
        break
      case "side":
        panels.push({ kind: "side", label: sideLabel(s.header, `Side #${++sideNo}`), text })
        break
      case "base":
        panels.push({ kind: "base", label: "Base", text })
        break
      case "gitbase":
        panels.push({ kind: "base", label: s.header || "Base", text })
        break
      case "gitsep":
        panels.push({ kind: "side", label: closeText || `Side #${++sideNo}`, text })
        break
      case "diff": {
        // A unified diff from base to this side; rebuild both versions.
        const side: string[] = [],
          base: string[] = [],
          added: string[] = [],
          removed: string[] = []
        for (const l of s.lines) {
          const body = l.slice(1)
          if (l.startsWith("+")) {
            side.push(body)
            added.push(body)
          } else if (l.startsWith("-")) {
            base.push(body)
            removed.push(body)
          } else {
            side.push(body)
            base.push(body)
          }
        }
        panels.push({
          kind: "side",
          label: sideLabel(s.header, `Side #${++sideNo}`),
          text: side.join("\n"),
          changed: added,
        })
        panels.push({
          kind: "base",
          label: "Base",
          text: base.join("\n"),
          changed: removed,
        })
        break
      }
    }
  }
  // jj's own styles title the region ("Conflict 1 of 1"); in git style the
  // open marker text names side 1 ("HEAD") instead.
  const title = /^Conflict \d+ of \d+$/.test(open[2] ?? "") ? open[2]! : "Merge conflict"
  return { title, panels }
}
