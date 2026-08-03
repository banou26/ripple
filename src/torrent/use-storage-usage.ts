// Local disk, not useQuota: a full origin throws QuotaExceededError, which opfs-storage treats as fatal

import { useEffect, useState } from 'react'

export type StorageUsage = {
  usedBytes: number
  // a browser-computed budget, not free disk: Chromium derives it from a share of free space and moves it as unrelated files come and go, Firefox reports a
  // flat per-origin ceiling. That is why the UI copy says "of the N your browser allows this site" rather than anything about disk, and why the low-storage
  // notice is role=status and not role=alert
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
