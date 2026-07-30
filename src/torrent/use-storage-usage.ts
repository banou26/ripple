// How much of the browser's storage budget this origin is using, so a library filling up
// is visible before writes start failing. When it does fill up, OPFSStorage.write throws
// QuotaExceededError, which opfs-storage.ts treats as fatal and does not retry, and
// libtorrent stops the torrent over it. There is no warning from the platform first.
//
// Not to be confused with useQuota, which is the FKN cloud-egress allowance. This one is
// local disk and involves no network at all.

import { useEffect, useState } from 'react'

export type StorageUsage = {
  // Everything this origin stores: OPFS payloads, the IndexedDB list and resume blobs, and
  // the browser's own accounting overhead. Deliberately padded by the browser, so it is an
  // honest total rather than a precise measure of the downloads.
  usedBytes: number
  // What the browser currently allows this origin, which is not free disk. Chromium derives
  // it from a share of the free space and moves it as unrelated files come and go; Firefox
  // reports a flat per-origin ceiling.
  limitBytes: number
  // A best-effort origin can be evicted wholesale when the device gets tight, which is the
  // state Ripple's restore path already has to model.
  persisted: boolean
}

// Absolute, not a percentage: what fails is a single piece write, so the only question is
// how many bytes are left, and torrent payloads are absolute sizes. A percentage would nag
// with 40 GB free on a large budget and stay quiet with 300 MB free on a small one.
export const LOW_STORAGE_BYTES = 2_000_000_000

const POLL_MS = 30_000

// Asked for once per page, and only once there is something worth protecting. Requesting
// on load would put Firefox's permission prompt in front of a user who has not downloaded
// anything yet, and Chromium grants it silently from engagement heuristics anyway.
let requested = false

export const useStorageUsage = (refreshKey: unknown): StorageUsage | null => {
  const [usage, setUsage] = useState<StorageUsage | null>(null)

  useEffect(() => {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.estimate) return
    let cancelled = false

    const read = async () => {
      // A hidden tab has its timers throttled and nobody reading the number, and the
      // visibilitychange listener below refreshes it the moment the tab comes back.
      if (document.visibilityState !== 'visible') return
      try {
        const [estimate, persisted] = await Promise.all([
          storage.estimate(),
          storage.persisted?.() ?? Promise.resolve(false),
        ])
        if (cancelled || estimate.usage === undefined || !estimate.quota) return
        setUsage({ usedBytes: estimate.usage, limitBytes: estimate.quota, persisted })
        if (!persisted && !requested && estimate.usage > 0 && storage.persist) {
          requested = true
          await storage.persist().catch(() => false)
        }
      } catch { /* the readout is optional; never let it take the page down */ }
    }

    void read()
    const timer = window.setInterval(() => { void read() }, POLL_MS)
    const onVisible = () => { void read() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // refreshKey re-reads on demand, so removing a torrent does not leave the old figure
    // on screen for up to half a minute and read as the button having done nothing.
  }, [refreshKey])

  return usage
}
