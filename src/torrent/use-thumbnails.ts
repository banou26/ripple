import { useEffect, useSyncExternalStore } from 'react'

import { get } from 'idb-keyval'

import type { TorrentClient } from './client'
import type { Persisted } from './library'

import { LIST_KEY } from './library'
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
export const useThumbnailGeneration = (
  client: TorrentClient,
  only?: string,
  /** Which files may supply the picture; see pickThumbnailSource. The library passes nothing. */
  eligible?: (index: number) => boolean,
) => {
  /**
   * Show the pictures already on this device WITHOUT waiting for the engine.
   *
   * They used to be loaded from `client.onState`, which does not fire until a worker has spawned,
   * compiled several megabytes of wasm, opened OPFS, created a session and restored the library.
   * That is seconds, and it made every reload look as though the thumbnails had been lost and were
   * being remade, when in fact they were sitting in IndexedDB the whole time: measured on the
   * owner's browser at 8 kB and 0.1 ms to read.
   *
   * Nothing about a stored picture needs the engine. The library list is in the same database, so
   * this reads it directly and paints whatever is already there, and the state-driven path below
   * still covers torrents added while the page is open.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      /*
       * `only` narrows this to one torrent, for the download page.
       *
       * That page is usually an embed on somebody else's site showing a single release, and the
       * visitor's library is none of its business: reading the whole list there would load and hold
       * an object URL for every picture on the device to draw one. The library page passes nothing
       * and still gets all of them.
       */
      const hashes = only
        ? [only]
        : ((await get<Persisted[]>(LIST_KEY).catch(() => undefined)) ?? []).map((e) => e.infoHash).filter(Boolean)
      if (!cancelled && hashes.length) await loadCachedThumbnails(hashes).catch(() => {})
    })()
    return () => { cancelled = true }
  }, [only])

  useEffect(() => {
    const paths = libavPaths()
    let cached = new Set<string>()
    return client.onState((all) => {
      const snapshots = only ? all.filter((snapshot) => magnetInfoHash(snapshot.magnet) === only) : all
      // a reload has pictures on disk long before it has the bytes to remake them
      const fresh = snapshots
        .map((snapshot) => magnetInfoHash(snapshot.magnet))
        .filter((infoHash): infoHash is string => !!infoHash && !cached.has(infoHash))
      if (fresh.length) {
        cached = new Set([...cached, ...fresh])
        void loadCachedThumbnails(fresh)
      }
      considerThumbnails(client, snapshots, paths, eligible)
    })
  }, [client, only, eligible])
}

/** The object URL for a torrent's picture, or null while there is not one. */
export const useThumbnail = (infoHash: string | undefined): string | null =>
  useSyncExternalStore(subscribeThumbnails, () => thumbnailFor(infoHash))
