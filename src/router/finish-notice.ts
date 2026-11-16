import type { Torrent } from '../torrent/types'

import { useEffect, useRef, useState } from 'react'

import { OK, PAGE_BG } from '../theme'
import { finished } from '../torrent/types'
import { isFramed } from '../utils/framed'

/**
 * How many of `rows` finished since the look that returned `seen`, and the `seen` to pass to the next look.
 *
 * A torrent counts once it has been seen downloading and then reads finished, so a library that starts up already
 * finished counts nothing. A temporary torrent never counts: the person did not add it.
 */
export const finishes = (seen: ReadonlySet<string>, rows: readonly Torrent[]): { count: number, seen: Set<string> } => {
  const next = new Set<string>()
  let count = 0
  for (const t of rows) {
    if (!t.infoHash || t.ephemeral === true) continue
    if (finished(t)) {
      if (seen.has(t.infoHash)) count++
    } else if (seen.has(t.infoHash) || t.state === 'downloading' || t.state === 'retrying') {
      next.add(t.infoHash)
    }
  }
  return { count, seen: next }
}

const ICON_SIZE = 64

/** `icon` drawn at the size a tab shows, with a dot in its top right corner, as a PNG data URL. */
const withDot = (icon: HTMLImageElement): string | null => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ICON_SIZE
  const pen = canvas.getContext('2d')
  if (!pen) return null
  pen.drawImage(icon, 0, 0, ICON_SIZE, ICON_SIZE)
  pen.beginPath()
  pen.arc(ICON_SIZE - 16, 16, 13, 0, 2 * Math.PI)
  pen.fillStyle = OK
  pen.fill()
  pen.lineWidth = 4
  pen.strokeStyle = PAGE_BG
  pen.stroke()
  return canvas.toDataURL('image/png')
}

/**
 * Tells a person who is elsewhere that downloads they added finished: while the tab is hidden, each one that finishes
 * adds one to a count shown as `(N) ` before the tab's title, as a dot on its icon and as the installed app's badge, and
 * all three go once the tab is seen again. Inside a frame it does nothing, since the title and the icon are the page's
 * around it.
 */
export const useFinishNotice = (torrents: readonly Torrent[]) => {
  const seen = useRef<ReadonlySet<string>>(new Set())
  const [count, setCount] = useState(0)

  useEffect(() => {
    const look = finishes(seen.current, torrents)
    seen.current = look.seen
    if (look.count && document.visibilityState === 'hidden' && !isFramed()) setCount((n) => n + look.count)
  }, [torrents])

  useEffect(() => {
    if (!count) return
    const seenAgain = () => { if (document.visibilityState === 'visible') setCount(0) }
    document.addEventListener('visibilitychange', seenAgain)
    return () => document.removeEventListener('visibilitychange', seenAgain)
  }, [count])

  useEffect(() => {
    if (!count) return
    const ordinary = document.title
    document.title = `(${count}) ${ordinary}`
    return () => { document.title = ordinary }
  }, [count])

  useEffect(() => {
    if (!count || !('setAppBadge' in navigator)) return
    navigator.setAppBadge(count).catch(() => {})
    return () => { navigator.clearAppBadge().catch(() => {}) }
  }, [count])

  const dotted = count > 0
  useEffect(() => {
    if (!dotted) return
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    const ordinary = link?.getAttribute('href')
    if (!link || !ordinary) return
    let live = true
    const icon = new Image()
    icon.onload = () => {
      const dot = live && withDot(icon)
      if (dot) link.href = dot
    }
    icon.src = link.href
    return () => {
      live = false
      link.setAttribute('href', ordinary)
    }
  }, [dotted])
}
