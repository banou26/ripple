// Local disk, not useQuota: a full origin throws QuotaExceededError, which opfs-storage treats as fatal

import { useEffect, useState } from 'react'

export type StorageUsage = {
  usedBytes: number
  /**
   * A browser-chosen budget, and NOT a share of free disk.
   *
   * This used to say Chromium derives it from free space. Measured 2026-08-30 on Chrome 151 and it
   * does not: exactly 10 GiB (10737418240 bytes, a round power of two) on a machine with 2.8 TiB
   * free, the same number for torrent.fkn.app and for example.com, and the same with the browser
   * profile on two different paths. Other machines report 2 GiB and 12 GiB, so it varies by
   * something, but nothing observed here tracks the disk.
   *
   * It also cannot be raised. `navigator.storage.persist()` asks for protection from EVICTION, not
   * for room, and it was refused on every attempt here (plain, after granting notifications, and
   * after a CDP durableStorage grant), so its effect on the number was never even observable.
   *
   * That is why the copy says "of the N your browser allows this site" rather than anything about
   * disk, why the low-storage notice is role=status and not role=alert, and why the only way out it
   * offers is moving bytes off the origin. See storage-relief.ts.
   */
  limitBytes: number
  // false means a best-effort origin, which can be evicted wholesale
  persisted: boolean
}

// absolute, not a percentage: what fails is a single piece write
export const LOW_STORAGE_BYTES = 2_000_000_000

const POLL_MS = 30_000

// requesting on load puts Firefox's permission prompt in front of a user with nothing stored
let requested = false

export const useStorageUsage = (refreshKey: unknown): StorageUsage | null => {
  const [usage, setUsage] = useState<StorageUsage | null>(null)

  useEffect(() => {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.estimate) return
    let cancelled = false

    const read = async () => {
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
      } catch { }
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
  }, [refreshKey])

  return usage
}
