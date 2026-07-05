import type { Persisted, TorrentClient } from './client'

import { useEffect, useState } from 'react'

import { account, cloud } from '@fkn/lib'

export const BACKUP_PATH = 'ripple/torrents.json'
const DEMO_SEEDED_KEY = 'ripple:demo-seeded'
const ACCOUNT_KEY = 'ripple:sync-account'
const WRITE_DEBOUNCE = 3_000
const RESTORE_RETRY = 5_000
const MAX_RESTORE_ATTEMPTS = 4

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'error'

// Resolves once the first cloud restore has settled (connected and merged, or
// signed out). useTorrents waits on this before deciding to seed the demo, so a
// returning user's restored library is never buried under the Sintel demo.
let settle: () => void
export const cloudRestoreSettled = new Promise<void>((resolve) => { settle = resolve })

// The connected account's display name, or null - bounded so a stalled broker
// never blocks the restore (and the demo gate) indefinitely.
const accountName = (): Promise<string | null> =>
  Promise.race([
    account.info().then((a) => a?.name ?? null),
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 4_000)),
  ]).catch(() => null)

// Mirrors the device-portable torrent-list index to FKN cloud storage so a
// signed-in user's library follows them across devices. Only the small
// Persisted[] index is synced (magnet + savePath + addedAt); the file bytes
// re-download from the swarm. cloud.fs needs a connected account, so this is a
// no-op when signed out - the local IndexedDB list keeps working regardless.
export const useCloudBackup = (clientRef: { current: TorrentClient | null }): SyncStatus => {
  const [status, setStatus] = useState<SyncStatus>('off')

  useEffect(() => {
    const client = clientRef.current
    if (!client) { settle(); return }

    let cancelled = false
    let connected = false
    // Writes stay disarmed until the current restore settles, so a transient read error or an account switch can never clobber a good cloud backup
    let restored = false
    let pending = false
    let latest: Persisted[] = []
    let timer: number | undefined
    let restoreTimer: number | undefined

    const writeNow = () => {
      pending = false
      window.clearTimeout(timer)
      // Sync only the device-portable identity, never device-local state like
      // `started` (whether this device has the files), so one device clearing its
      // storage can't demote the entry in the shared backup.
      const portable = latest.map((e) => ({ infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath, addedAt: e.addedAt }))
      return cloud.fs.promises.writeFile(BACKUP_PATH, JSON.stringify(portable), { contentType: 'application/json' })
    }
    const write = async () => {
      if (cancelled || !connected || !restored) return
      setStatus('syncing')
      try { await writeNow(); if (!cancelled) setStatus('synced') }
      catch { if (!cancelled) setStatus('error') }
    }
    const schedule = () => { pending = true; window.clearTimeout(timer); timer = window.setTimeout(write, WRITE_DEBOUNCE) }
    // Fire a pending write before the page or route goes away, so the last change
    // inside the debounce window still reaches the cloud (best-effort on pagehide).
    const flush = () => { if (pending && connected && restored) writeNow().catch(() => {}) }

    const offList = client.onList((list) => { latest = list; if (connected) schedule() })

    const restore = async (attempt = 0) => {
      restored = false
      pending = false
      window.clearTimeout(timer)
      let ok = false
      try { ok = await cloud.fs.available() } catch {}
      if (cancelled) return
      connected = ok
      if (!ok) { setStatus('off'); return }

      // If the device-local list belongs to a different account than the one now
      // connected, wipe it first so one account's library is never uploaded into
      // another's backup.
      const name = await accountName()
      if (cancelled) return
      if (name) {
        let prev: string | null = null
        try { prev = localStorage.getItem(ACCOUNT_KEY) } catch {}
        if (prev && prev !== name) { client.clearList(); latest = [] }
        try { localStorage.setItem(ACCOUNT_KEY, name) } catch {}
      }

      setStatus('syncing')
      let text: string | null = null
      let missing = false
      try {
        text = String(await cloud.fs.promises.readFile(BACKUP_PATH, 'utf8'))
      } catch (err) {
        // Only a definitive "not found" means no backup yet; anything else is transient and must never seed over an existing backup
        missing = /not found/i.test((err as { message?: string })?.message ?? '')
      }
      if (cancelled) return

      if (text !== null) {
        let list: unknown
        try { list = JSON.parse(text) } catch {}
        if (Array.isArray(list)) {
          // A restorable backup - even an empty one - means a returning user, so
          // suppress the demo and never let it re-pollute an emptied library.
          try { localStorage.setItem(DEMO_SEEDED_KEY, '1') } catch {}
          if (list.length) client.importList(list)
        }
        restored = true
        setStatus('synced')
      } else if (missing) {
        // Genuinely no backup for this account yet: seed it with the current local list.
        restored = true
        setStatus('synced')
        if (latest.length) schedule()
      } else {
        // Transient read failure: keep writes disarmed (restored stays false) so nothing clobbers a
        // possibly-good backup, surface the error, and retry a few times before giving up.
        setStatus('error')
        if (attempt < MAX_RESTORE_ATTEMPTS) {
          window.clearTimeout(restoreTimer)
          restoreTimer = window.setTimeout(() => restore(attempt + 1), RESTORE_RETRY)
        }
      }
    }

    let offAccount: (() => void) | undefined
    account.onChange(() => { if (!cancelled) restore() })
      .then((off) => { if (cancelled) off(); else offAccount = off })
      .catch(() => {})
    restore().finally(() => settle())

    window.addEventListener('pagehide', flush)

    return () => {
      flush()
      window.removeEventListener('pagehide', flush)
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(restoreTimer)
      offList()
      offAccount?.()
    }
  }, [clientRef])

  return status
}
