// Turning a chosen set of files back into the shortest `files=` a URL can carry.
//
// This is the exact inverse of file-selection.ts, and the two are tested against each other: what
// this writes, that must read back as the same set. Kept pure and apart from the panel so the
// grammar can be checked without a browser, a torrent or an engine.

import type { EmbedMode } from './file-selection'

import { encodeMagnetParam } from './magnet-codec'
import { getRoutePath, Route } from './path'

export { decodeMagnetParam, encodeMagnetParam } from './magnet-codec'

/**
 * The shortest `files=` value naming exactly `indices`, or null when the param should be OMITTED.
 *
 * null means "every file", which is what an absent `files` already means, so leaving it out is both
 * shorter and the thing a reader understands without consulting the grammar.
 *
 * An EMPTY selection returns null too, and that is a widening: it would hand somebody the whole
 * torrent when they asked for none of it. The grammar simply cannot express "no files" (junk and
 * absence both resolve to all), so a caller must never produce one. The panel disables its output
 * at zero rather than emitting a link that means the opposite of what is on screen.
 */
export const compileFileSelection = (indices: number[], fileCount: number): string | null => {
  const picked = [...new Set(indices)].filter((i) => Number.isSafeInteger(i) && i >= 0 && i < fileCount).sort((a, b) => a - b)
  if (!picked.length) return null
  if (picked.length === fileCount) return null

  const parts: string[] = []
  for (let i = 0; i < picked.length;) {
    // walk the run of consecutive indices starting here, so 3,4,5 collapses to "3-5"
    let end = i
    while (end + 1 < picked.length && picked[end + 1] === picked[end]! + 1) end++
    parts.push(i === end ? String(picked[i]) : `${picked[i]}-${picked[end]}`)
    i = end + 1
  }
  return parts.join(',')
}

export type EmbedLink = {
  magnet: string
  mode: EmbedMode
  /**
   * Which files the link names. Read in DOWNLOAD mode only.
   *
   * The player never looks at `files` (it reads `fileIndex`), so putting a set on a watch link
   * would be silently ignored and the embed would open whatever the player picked for itself.
   */
  indices?: number[]
  fileCount?: number
  /** The single file a watch link opens. Ignored in download mode, which uses `indices`. */
  fileIndex?: number
}

/**
 * The `/embed?...` path for a link, relative to the app root.
 *
 * Built through getRoutePath rather than by hand so whichever form the codec picked goes through
 * URLSearchParams. That matters for the legacy fallback, whose base64 can carry `+`, `/` and `=`:
 * written literally into a query string a `+` reads back as a space and the magnet fails to decode.
 * The packed form is base64url and needs no escaping, which is part of why it is shorter.
 */
export const embedPath = ({ magnet, mode, indices, fileCount, fileIndex }: EmbedLink): string | null => {
  const encoded = encodeMagnetParam(magnet)
  if (encoded === null) return null
  // spread rather than a computed key so the two parameter names stay distinguishable to the type
  // checker, and so the torrent leads the query as every published example shows it
  const source = encoded.key === 'm' ? { m: encoded.value } : { magnet: encoded.value }
  const rest: { mode?: 'download', files?: string, fileIndex?: string } = {}
  // `watch` is the default, so saying it adds length and no meaning
  if (mode === 'download') {
    rest.mode = 'download'
    const files = compileFileSelection(indices ?? [], fileCount ?? 0)
    if (files) rest.files = files
  } else if (fileIndex != null && fileIndex > 0) {
    // fileIndex=0 is what an absent one already means
    rest.fileIndex = String(fileIndex)
  }

  return getRoutePath(Route.EMBED, { ...source, ...rest })
}

/** The absolute link to hand somebody, against the origin this app is served from. */
export const embedUrl = (link: EmbedLink, origin = window.location.origin): string | null => {
  const path = embedPath(link)
  return path === null ? null : origin + path
}

/**
 * The frame to paste into a page.
 *
 * `allow-downloads` is not optional on a download link and is the single most common way for one to
 * fail: nested sandbox flags are the UNION of the embedder's and the frame's, so a frame cannot
 * restore what the page above withheld, and Chrome refuses the download with no event and nothing
 * thrown. `allow-same-origin` is what lets the engine reach its own storage.
 */
export const embedIframe = (link: EmbedLink, origin?: string): string | null => {
  const url = embedUrl(link, origin)
  if (url === null) return null
  const sandbox = ['allow-scripts', 'allow-same-origin', 'allow-popups']
  if (link.mode === 'download') sandbox.push('allow-downloads')
  return [
    `<iframe src="${url}"`,
    `        width="100%" height="480" frameborder="0"`,
    `        allowfullscreen`,
    `        sandbox="${sandbox.join(' ')}"></iframe>`,
  ].join('\n')
}
