/// <reference lib="dom" />

// The diff mode's base picker (client.ts): a popover under the base in the
// file page's bar, with a field for any revset and the last revisions that
// changed the file (revisions.ts), with the working copy, trunk's commit and
// the one shown among them where they fall. Picking one shows the changes
// starting with it, and trunk's the changes since it. Typing filters them,
// arrows move through them, Enter picks the one moved to or else what's
// typed, and Escape closes. Its markup is in page.ts.

import type { Revision } from "./revisions.ts"

/** Wire up `picker`, a popover; `page` is the file's page URL, `shown` the
 * revset shown now, and `pick` gets the revset picked */
export function setUpBasePicker(
  picker: HTMLElement,
  page: URL,
  shown: () => string,
  pick: (rev: string) => void,
) {
  const input = picker.querySelector("input")!
  const list = picker.querySelector("ul")!
  let bases: { history: Revision[]; trunk: Revision | null } | null = null
  let active = -1
  const options = () => [...list.querySelectorAll<HTMLLIElement>("[role=option]")]

  function render() {
    if (!bases) {
      list.innerHTML = '<li class="note">Loading…</li>'
      return
    }
    const q = input.value.trim().toLowerCase()
    const { history, trunk } = bases
    // Trunk's row shows the changes since it, not starting with it
    const rows = history.map((r) => {
      const li = row(r)
      if (r.commit === trunk?.commit) li.dataset.rev = "trunk()"
      else if (r.workingCopy) li.dataset.rev = ""
      return li
    })
    list.replaceChildren(
      ...rows.filter((li) => !q || li.textContent!.toLowerCase().includes(q)),
    )
    setActive(-1)
  }

  /** A row for a revision that changed the file: picking it shows the changes
   * starting with it, so the diff is from its parent */
  function row(r: Revision) {
    const li = document.createElement("li")
    li.setAttribute("role", "option")
    li.dataset.rev = `${r.change}-`
    li.innerHTML = `<span class="title"></span><span class="detail"></span><span class="stat"></span>`
    const [title, detail, stat] = li.children
    for (const b of r.bookmarks.split(" ").filter(Boolean)) {
      const chip = document.createElement("span")
      chip.className = "bookmark"
      chip.textContent = b
      title.append(chip, " ")
    }
    title.append(r.description || (r.workingCopy ? "The working copy" : "(no description)"))
    detail.textContent = `${r.change} · ${r.ago}`
    stat.innerHTML = `<ins>+${r.added}</ins> <del>−${r.removed}</del>`
    return li
  }

  function setActive(i: number) {
    active = i
    options().forEach((li, j) => li.setAttribute("aria-selected", String(j === i)))
    options()[i]?.scrollIntoView({ block: "nearest" })
  }

  function choose(rev: string) {
    picker.hidePopover()
    pick(rev)
  }

  // Under the button that opens it, fresh each time, since the file's
  // history changes as you work
  picker.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return
    const button = document.querySelector(`[popovertarget="${picker.id}"]`)
    const box = button?.getBoundingClientRect()
    picker.style.top = `${(box?.bottom ?? 40) + 4}px`
    picker.style.left = `${box?.left ?? 40}px`
    input.value = ""
    bases = null
    render()
    const url = new URL("bases", page)
    url.searchParams.set("rev", shown())
    void fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((found) => {
        bases = found ?? { history: [], trunk: null }
        render()
      })
  })
  picker.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "open") input.focus()
  })
  input.addEventListener("input", render)
  input.addEventListener("keydown", (e) => {
    const n = options().length
    if (e.key === "ArrowDown") setActive(Math.min(active + 1, n - 1))
    else if (e.key === "ArrowUp") setActive(Math.max(active - 1, -1))
    else if (e.key === "Enter") {
      const rev = options()[active]?.dataset.rev ?? input.value.trim()
      if (rev || active >= 0) choose(rev)
    } else return
    e.preventDefault()
  })
  list.addEventListener("click", (e) => {
    const li = (e.target as Element).closest<HTMLLIElement>("[role=option]")
    if (li) choose(li.dataset.rev!)
  })
}
