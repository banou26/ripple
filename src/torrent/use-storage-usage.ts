// Local disk, not useQuota: a full origin throws QuotaExceededError, which opfs-storage treats as fatal

import { useEffect, useState } from 'react'

import { storage } from '@banou/ponyfill'

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
   * WHETHER IT CAN BE RAISED DEPENDS ON THE ENGINE, and this comment said flatly that it cannot
   * until 2026-09-01.
   *
   * On Chromium it cannot, and the reasoning above stands: `navigator.storage.persist()` was refused
   * on every attempt here (plain, after granting notifications, and after a CDP durableStorage
   * grant), no prompt was ever raised, and the number did not move.
   *
   * On Firefox the same call is what SETS this number. Measured 2026-09-01 on torrent.fkn.app:
   * granting the "Store data in persistent storage" doorhanger moved the reported quota from 12 GB
   * to 3.97 TB on a device holding 7.3 TiB (8.03 TB), which is about half the disk and roughly 330
   * times the previous figure.
   *
   * The old claim came from Chromium alone, through a call that never once succeeded, so what a
   * success does was never observable there. The ask itself lives in use-persistent-storage.ts and
   * what it is worth offering is in storage-permission.ts.
   *
   * That is why the copy says "of the N your browser allows this site" rather than anything about
   * disk, why the low-storage notice is role=status and not role=alert, and why the way out it
   * offers on every engine is moving bytes off the origin. See storage-relief.ts.
   */
  limitBytes: number
  // false means a best-effort origin, which can be evicted wholesale
  persisted: boolean
}

// absolute, not a percentage: what fails is a single piece write
export const LOW_STORAGE_BYTES = 2_000_000_000

const POLL_MS = 30_000

export const useStorageUsage = (refreshKey: unknown): StorageUsage | null => {
  const [usage, setUsage] = useState<StorageUsage | null>(null)

  useEffect(() => {
    // no guard on the API being present: the ponyfill answers an empty estimate where there is no
    // Storage API at all, and `!estimate.quota` below is what turns that into "say nothing"
    let cancelled = false

    const read = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        /**
         * Measured rather than believed, which `@banou/ponyfill` does inside `estimate()`. Chrome 151
         * reported 752 bytes of file system against a verified 1.78 GB of torrent data, which put
         * "2 MB / 10.74 GB" on screen above a library plainly holding more than that.
         *
         * Once every 30 seconds and only while the tab is visible, which is the cadence this poll
         * already ran at, so the walk it does costs nothing anyone can perceive.
         */
        const [estimate, persisted] = await Promise.all([
          storage.estimate(),
          storage.persisted(),
        ])
        if (cancelled || !estimate.quota || estimate.usage === undefined) return
        setUsage({ usedBytes: estimate.usage, limitBytes: estimate.quota, persisted })
        /**
         * THIS POLL NO LONGER ASKS FOR ANYTHING. It used to call `storage.persist()` here the first
         * time measured usage passed zero, which on Firefox raises a permission doorhanger as a side
         * effect of the first byte written, with nothing on screen saying what it is for or that the
         * answer decides the quota.
         *
         * A person gets one of those. It is spent from the storage warning instead, where the reason
         * is already on screen and the figures are next to the button. The ask is in
         * use-persistent-storage.ts and what is worth offering is in storage-permission.ts.
         *
         * One case there is still automatic: where the permission query already answers 'granted'
         * there is nothing left to ask, so the call registers the protection without interrupting
         * anybody. That one moved into the hook's mount effect rather than staying here, because it
         * is a one-time settle and a poll had to carry a module-level flag to stop repeating it.
         */
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
