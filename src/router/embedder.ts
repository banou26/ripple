import { useEffect, useRef } from 'react'

/**
 * What the page framing /watch may ask of it, beside the player's own channel (`@banou/media-player/remote`).
 *
 * `open` plays another file in this same document, through a replace navigation, so the frame, the engine and the
 * viewer's keys stay, and the tab's history gains no step. It is answered with `{ ripple: 'opened' }`, which is how
 * an embedder tells this ripple from one that would ignore it. `prepare` claims a file's head and tail ahead of an
 * `open` of it (`TorrentClient.prepare`), replacing the last one asked. `fileIndex` is the file of the torrent, and
 * left out it is the torrent's video file. Only the framing window is heard.
 */
export type EmbedderAsk = { ripple: 'open' | 'prepare', magnet: string, fileIndex?: number }

export const embedderAsk = (data: unknown): EmbedderAsk | undefined => {
  if (!data || typeof data !== 'object') return undefined
  const { ripple, magnet, fileIndex } = data as Record<string, unknown>
  if ((ripple !== 'open' && ripple !== 'prepare') || typeof magnet !== 'string' || !magnet.startsWith('magnet:')) return undefined
  if (fileIndex !== undefined && !(typeof fileIndex === 'number' && Number.isInteger(fileIndex) && fileIndex >= 0)) return undefined
  return { ripple, magnet, ...fileIndex === undefined ? {} : { fileIndex } }
}

export const useEmbedder = (on: (ask: EmbedderAsk) => void) => {
  const latest = useRef(on)
  useEffect(() => { latest.current = on })
  useEffect(() => {
    if (window.parent === window) return
    const hear = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const ask = embedderAsk(event.data)
      if (!ask) return
      latest.current(ask)
      if (ask.ripple === 'open') window.parent.postMessage({ ripple: 'opened' }, event.origin === 'null' ? '*' : event.origin)
    }
    window.addEventListener('message', hear)
    return () => window.removeEventListener('message', hear)
  }, [])
}
