import type { Persisted } from './client'

import { useEffect, useState } from 'react'

import { account, cloud } from '@fkn/lib'

import { getTorrentClient } from './client'
import { DEMO_SEEDED_KEY } from './constants'

export const BACKUP_PATH = 'ripple/torrents.json'
const ACCOUNT_KEY = 'ripple:sync-account'
const WRITE_DEBOUNCE = 3_000
// Restores retry forever on this (the last delay repeats); never add a give-up. Giving up used to leave writes disarmed for the life of the page, so a library
// edited after a passing broker glitch never reached the cloud again and nothing re-armed it
const RESTORE_BACKOFF = [5_000, 10_000, 20_000, 40_000, 60_000]
const BROKER_TIMEOUT = 10_000

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'error'

// Resolves once the first cloud restore has settled; useTorrents waits on this before deciding to seed the demo
let settle: () => void
export const cloudRestoreSettled = new Promise<void>((resolve) => { settle = resolve })

// The broker reports each with a reserved marker that survives the osra boundary (custom props are stripped, the message and `code` are not)
const isLocked = (err: unknown): boolean => (err as { code?: string })?.code === 'FKN_E2E_LOCKED'
const isUnreadable = (err: unknown): boolean => {
  const message = (err as { message?: string })?.message ?? ''
  return message.startsWith('fkn:e2e-integrity') || message.startsWith('fkn:e2e-stale-epoch')
}

const bounded = <T>(work: Promise<T>, fallback: T, ms = BROKER_TIMEOUT): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('broker timed out')), ms)),
  ]).catch((err) => {
    if ((err as Error)?.message === 'broker timed out') return fallback
    throw err
  })

const accountName = (): Promise<string | null> =>
  bounded(account.info().then((a) => a?.name ?? null), null, 4_000).catch(() => null)

export const useCloudBackup = (): SyncStatus => {
  const client = getTorrentClient()
  const [status, setStatus] = useState<SyncStatus>('off')
  // Only the tab hosting the engine syncs: one writer, and it is the tab that owns the library
  const [owned, setOwned] = useState(false)
  useEffect(() => client.onOwnership(setOwned), [client])

  useEffect(() => {
    if (!owned) return
    let cancelled = false
    let connected = false
    let restored = false
    let pending = false
    let latest: Persisted[] = []
    let timer: number | undefined
    let restoreTimer: number | undefined
    // Only the newest restore pass is allowed to act: a stale one resumes against shared state and finishes the job for the wrong account
    let generation = 0
    // Which account the armed writes belong to: the 3s debounce fires after the pass that armed it, so the write itself has to re-check, not just the restore,
    // or a debounced write lands in the wrong account's backup after a switch
    let writesFor: string | null = null
    let promptedUnlock = false

    const currentAccount = (): string | null => {
      try { return localStorage.getItem(ACCOUNT_KEY) } catch { return null }
    }

    const writeNow = () => {
      pending = false
      window.clearTimeout(timer)
      // Sync only the device-portable identity, never device-local state like `started` or `paused`
      const portable = latest.map((e) => ({ infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath, addedAt: e.addedAt }))
      return cloud.fs.promises.writeFile(BACKUP_PATH, JSON.stringify(portable), { contentType: 'application/json' })
    }
    const write = async () => {
      if (cancelled || !connected || !restored) return
      if (writesFor !== currentAccount()) return
      setStatus('syncing')
      try { await writeNow(); if (!cancelled) setStatus('synced') }
      catch (err) {
        if (cancelled) return
        // One retry only, so a persistent lock cannot loop the modal unlock card in front of the user every minute
        if (isLocked(err)) {
          let unlocked = false
          try { unlocked = await cloud.fs.unlock() } catch {}
          if (cancelled) return
          if (unlocked) {
            try { await writeNow(); if (!cancelled) setStatus('synced'); return } catch {}
            if (cancelled) return
          }
        }
        setStatus('error')
      }
    }
    const schedule = () => { pending = true; window.clearTimeout(timer); timer = window.setTimeout(write, WRITE_DEBOUNCE) }
    const flush = () => {
      if (pending && connected && restored && writesFor === currentAccount()) writeNow().catch(() => {})
    }

    const offList = client.onList((list) => { latest = list; if (connected) schedule() })

    const retryLater = (attempt: number) => {
      window.clearTimeout(restoreTimer)
      const delay = RESTORE_BACKOFF[Math.min(attempt, RESTORE_BACKOFF.length - 1)]!
      restoreTimer = window.setTimeout(() => restore(attempt + 1), delay)
    }

    const restore = async (attempt = 0) => {
      const gen = ++generation
      const stale = () => cancelled || gen !== generation
      restored = false
      pending = false
      writesFor = null
      window.clearTimeout(timer)
      window.clearTimeout(restoreTimer)
      let available: boolean | null = null
      try { available = await bounded<boolean | null>(cloud.fs.available().then(Boolean), null) } catch {}
      if (stale()) return
      if (available === null) { setStatus('error'); retryLater(attempt); return }
      connected = available
      if (!connected) { setStatus('off'); return }

      const name = await accountName()
      if (stale()) return
      // A null name is "we do not know who this is", not "nobody": merging the local list into that account's backup would hand one user's library to another
      if (name === null && currentAccount() !== null) { setStatus('error'); retryLater(attempt); return }

      setStatus('syncing')
      let text: string | null = null
      let missing = false
      let locked = false
      try {
        const read = await bounded<string | null>(cloud.fs.promises.readFile(BACKUP_PATH, 'utf8').then(String), null)
        if (read === null) throw new Error('broker timed out')
        text = read
      } catch (err) {
        // Anything other than a definitive "not found" or unreadable bytes is transient and must never seed over a backup that may still be good
        missing = /not found/i.test((err as { message?: string })?.message ?? '') || isUnreadable(err)
        locked = isLocked(err)
      }
      if (stale()) return

      if (locked) {
        // The card is modal inside the broker's own frame and the read itself is what raises it, so offer it once per mount and never again; the backoff keeps
        // running underneath, so a scope unlocked by other means still recovers
        if (!promptedUnlock) {
          promptedUnlock = true
          try { await bounded(cloud.fs.unlock(), false) } catch {}
          if (stale()) return
        }
        setStatus('error')
        retryLater(attempt)
        return
      }

      // The list on this device belongs to whichever account was last synced, so drop it only once this account's backup has actually been read
      const previous = currentAccount()
      const switched = !!name && !!previous && previous !== name
      if (switched && text === null && !missing) {
        setStatus('error')
        retryLater(attempt)
        return
      }
      if (switched) { client.clearList(); latest = [] }
      if (name) { try { localStorage.setItem(ACCOUNT_KEY, name) } catch {} }
      writesFor = name

      if (text !== null) {
        let list: unknown
        try { list = JSON.parse(text) } catch {}
        if (Array.isArray(list)) {
          // A restorable backup - even an empty one - means a returning user, so suppress the demo
          try { localStorage.setItem(DEMO_SEEDED_KEY, '1') } catch {}
          if (list.length) client.importList(list)
        }
        restored = true
        setStatus('synced')
        if (latest.length) schedule()
      } else if (missing) {
        restored = true
        setStatus('synced')
        if (latest.length) schedule()
      } else {
        setStatus('error')
        retryLater(attempt)
      }
    }

    let offAccount: (() => void) | undefined
    account.onChange(() => { if (!cancelled) restore() })
      .then((off) => { if (cancelled) off(); else offAccount = off })
      .catch(() => {})
    restore().finally(() => settle())

    const onOnline = () => { if (!cancelled && !restored) restore() }
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', flush)

    return () => {
      flush()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', flush)
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(restoreTimer)
      offList()
      offAccount?.()
    }
  }, [client, owned])

  return status
}
