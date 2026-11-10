/// <reference lib="dom" />

// GitHub embeds in the preview, filling the placeholders render.ts leaves for
// a bare permalink or asset URL on its own line: a permalink's lines as a
// highlighted snippet, an asset as an image or video, which the server
// fetches (github.ts).

import { languages } from "@codemirror/language-data"
import { LanguageDescription } from "@codemirror/language"
import { escapeHtml } from "../escape.ts"
import { highlightElement } from "./highlight.ts"
import { permalinkRe } from "./render.ts"

// Resolved embed contents, keyed by URL and shared by every element on the
// page. Permalinks are immutable and asset redirects stay valid long enough
// for a session, so nothing expires.
const embedCache = new Map<string, Promise<HTMLElement>>()

/** `base` is a file's page; the embed fetchers sit one level up, shared */
function buildEmbed(href: string, base: URL): Promise<HTMLElement> {
  let p = embedCache.get(href)
  if (!p) {
    p = (
      permalinkRe.test(href) ? buildBlobEmbed(href, base) : buildAssetEmbed(href, base)
    ).catch((e) => {
      embedCache.delete(href) // retry on next render
      const el = document.createElement("div")
      el.className = "gh-embed-error"
      el.textContent = `couldn't load embed: ${e instanceof Error ? e.message : e}`
      return el
    })
    embedCache.set(href, p)
  }
  return p
}

async function buildBlobEmbed(href: string, base: URL): Promise<HTMLElement> {
  const [, owner, repo, ref, path, startStr, endStr] = permalinkRe.exec(href)!
  const start = Number(startStr)
  const end = endStr ? Number(endStr) : start
  const q = new URLSearchParams({ owner, repo, ref, path })
  const res = await fetch(new URL(`../gh/blob?${q}`, base))
  if (!res.ok) throw new Error(await res.text())
  const lines = (await res.text()).split("\n").slice(start - 1, end)
  const code = lines.join("\n")

  const root = document.createElement("div")
  root.className = "gh-blob"
  const header = document.createElement("div")
  header.className = "gh-blob-header"
  const shortRef = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref
  header.innerHTML = `<a href="${escapeHtml(href)}" target="_blank">${escapeHtml(
    repo + "/" + path,
  )}</a> <span>${start === end ? `Line ${start}` : `Lines ${start} to ${end}`} in <code>${escapeHtml(
    shortRef,
  )}</code></span>`
  const body = document.createElement("div")
  body.className = "gh-blob-body"
  const gutter = document.createElement("pre")
  gutter.className = "gh-blob-gutter"
  gutter.textContent = lines.map((_, i) => start + i).join("\n")
  const pre = document.createElement("pre")
  const codeEl = document.createElement("code")
  codeEl.textContent = code
  pre.append(codeEl)
  body.append(gutter, pre)
  root.append(header, body)
  const desc = LanguageDescription.matchFilename(languages, path)
  if (desc) await highlightElement(codeEl, desc, { detached: true })
  return root
}

async function buildAssetEmbed(href: string, base: URL): Promise<HTMLElement> {
  const res = await fetch(
    new URL(`../gh/asset?${new URLSearchParams({ url: href })}`, base),
  )
  if (!res.ok) throw new Error(await res.text())
  const { src, type } = (await res.json()) as { src: string; type: string }
  if (type.startsWith("video/")) return assetVideo(src)
  const img = document.createElement("img")
  img.src = src
  img.alt = href
  // The type is inferred from the URL and may be missing
  if (!type) img.dataset.untyped = ""
  return img
}

function assetVideo(src: string): HTMLVideoElement {
  const video = document.createElement("video")
  video.src = src
  video.controls = true
  video.muted = true
  return video
}

/** An asset of unknown type that fails to load as an image is most likely
 * a video */
export function videoForFailedImage({ target }: Event) {
  if (target instanceof HTMLImageElement && target.matches(".gh-embed img[data-untyped]")) {
    target.replaceWith(assetVideo(target.src))
  }
}

/** The last render's loaded embeds by URL, to move into the next one. Failed
 * ones are left out so they retry. */
export function hydratedEmbeds(content: HTMLElement): Map<string, Node[]> {
  const embeds = new Map<string, Node[]>()
  for (const el of content.querySelectorAll<HTMLElement>(".gh-embed.hydrated")) {
    const child = el.firstElementChild
    if (!child || child.classList.contains("gh-embed-error")) continue
    embeds.set(el.dataset.src!, [...(embeds.get(el.dataset.src!) ?? []), child])
  }
  return embeds
}

export async function hydrateEmbeds(
  content: HTMLElement,
  base: URL,
  previous: Map<string, Node[]>,
) {
  // A fresh copy of an image or video has no size until it loads, so the
  // page above would shrink and the view jump on every re-render. Move the
  // loaded ones over before the browser paints.
  const fresh: HTMLElement[] = []
  for (const el of content.querySelectorAll<HTMLElement>(".gh-embed[data-src]")) {
    const old = previous.get(el.dataset.src!)?.shift()
    if (!old) {
      fresh.push(el)
      continue
    }
    el.replaceChildren(old)
    el.classList.add("hydrated")
  }
  for (const el of fresh) {
    const built = await buildEmbed(el.dataset.src!, base)
    if (!el.isConnected) continue // a re-render replaced this block mid-load
    el.replaceChildren(built.cloneNode(true))
    el.classList.add("hydrated")
  }
}
