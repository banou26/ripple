import { useEffect, useSyncExternalStore } from 'react'

import type { TorrentClient } from './client'

import { magnetInfoHash } from './magnet'
import {
  considerThumbnails,
  loadCachedThumbnails,
  subscribeThumbnails,
  thumbnailFor,
} from './thumbnail-store'

/**
 * Where libav's worker and wasm are served from.
 *
 * The same two values the player computes for itself. In dev they sit under /build because the
 * worker and the .wasm are copied there by the build script rather than being bundled, and vite
 * serves the project root; in a real build they are at the origin root.
 */
const libavPaths = () => {
  const origin = new URL(window.location.toString()).origin
  return {
    publicPath: new URL(import.meta.env.DEV ? '/build/' : '/', origin).toString(),
    workerUrl: new URL(`${import.meta.env.DEV ? '/build' : ''}/libav-worker.js`, origin).toString(),
  }
}

/**
 * Drives thumbnail generation for the whole library. Mounted ONCE, by the page that owns the list.
 *
 * It reads the engine's state directly rather than taking the UI's torrent list, because the
 * decision of whether a picture can be made at all is a question about the piece BITFIELD, and that
 * is dropped on the way to the UI type. Reading it here is also what keeps every read inside bytes
 * that already exist, so generation never competes with a download.
 */
export const useThumbnailGeneration = (client: TorrentClient) => {
  useEffect(() => {
    const paths = libavPaths()
    let cached = new Set<string>()
    return client.onState((snapshots) => {
      // a reload has pictures on disk long before it has the bytes to remake them
      const fresh = snapshots
        .map((snapshot) => magnetInfoHash(snapshot.magnet))
        .filter((infoHash): infoHash is string => !!infoHash && !cached.has(infoHash))
      if (fresh.length) {
        cached = new Set([...cached, ...fresh])
        void loadCachedThumbnails(fresh)
      }
      considerThumbnails(client, snapshots, paths)
    })
  }, [client])
}

/** The object URL for a torrent's picture, or null while there is not one. */
export const useThumbnail = (infoHash: string | undefined): string | null =>
  useSyncExternalStore(subscribeThumbnails, () => thumbnailFor(infoHash))
