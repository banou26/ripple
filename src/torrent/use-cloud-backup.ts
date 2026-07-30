import type { Persisted } from './client'

import { useEffect, useState } from 'react'

import { account, cloud } from '@fkn/lib'

import { getTorrentClient } from './client'
import { DEMO_SEEDED_KEY } from './constants'

export const BACKUP_PATH = 'ripple/torrents.json'
const ACCOUNT_KEY = 'ripple:sync-account'
const WRITE_DEBOUNCE = 3_000
// Restores retry forever on a widening backoff. Giving up used to leave writes disarmed
// for the life of the page, so a library edited after a passing broker glitch never
// reached the cloud again and nothing re-armed it.
const RESTORE_BACKOFF = [5_000, 10_000, 20_000, 40_000, 60_000]
// Nothing in the broker surface has a deadline of its own, so a suspended one would
// otherwise park a restore pass forever with writes disarmed behind it.
const BROKER_TIMEOUT = 10_000

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'error'

// Resolves once the first cloud restore has settled (connected and merged, or
// signed out). useTorrents waits on this before deciding to seed the demo, so a
// returning user's restored library is never buried under the Sintel demo.
let settle: () => void
export const cloudRestoreSettled = new Promise<void>((resolve) => { settle = resolve })

// Cloud storage is end to end encrypted, so a read can fail in ways that are neither
// "no backup yet" nor a passing glitch. The broker reports each with a reserved marker
// that survives the osra boundary (custom props are stripped, the message and `code`
// are not), and each needs a different answer:
//
//   locked      the scope's key is not loaded in the broker right now. Recoverable, but
//               only by a real click inside the broker's own frame, so we ask it to
//               offer its unlock card and then retry.
//   unreadable  the stored bytes can never be decrypted here: either they predate
//               client-side sealing, or they are sealed under a key epoch that was
//               reset. Retrying cannot help, so treat it as having no usable backup
//               and re-seed from the local list rather than wedging on 'error'.
const isLocked = (err: unknown): boolean => (err as { code?: string })?.code === 'FKN_E2E_LOCKED'
const isUnreadable = (err: unknown): boolean => {
  const message = (err as { message?: string })?.message ?? ''
  return message.startsWith('fkn:e2e-integrity') || message.startsWith('fkn:e2e-stale-epoch')
}

// Every broker call goes through this: the osra boundary can suspend without ever
// settling, and a restore parked on one holds writes disarmed behind it.
const bounded = <T>(work: Promise<T>, fallback: T, ms = BROKER_TIMEOUT): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('broker timed out')), ms)),
  ]).catch((err) => {
    if ((err as Error)?.message === 'broker timed out') return fallback
    throw err
  })

// The connected account's display name, or null - bounded so a stalled broker
// never blocks the restore (and the demo gate) indefinitely.
const accountName = (): Promise<string | null> =>
  bounded(account.info().then((a) => a?.name ?? null), null, 4_000).catch(() => null)

// Mirrors the device-portable torrent-list index to FKN cloud storage so a
// signed-in user's library follows them across devices. Only the small
// Persisted[] index is synced (magnet + savePath + addedAt); the file bytes
// re-download from the swarm. cloud.fs needs a connected account, so this is a
// no-op when signed out - the local IndexedDB list keeps working regardless.
export const useCloudBackup = (): SyncStatus => {
  const client = getTorrentClient()
  const [status, setStatus] = useState<SyncStatus>('off')
  // Only the tab hosting the engine syncs. Every open tab sees the same list and the same
  // account, so running this in all of them would have each one restore the backup and then
  // race the others to write it back, with the debounce making the loser's copy the one that
  // lands. One writer, and it is the tab that owns the library.
  const [owned, setOwned] = useState(false)
  useEffect(() => client.onOwnership(setOwned), [client])

  useEffect(() => {
    if (!owned) return
    let cancelled = false
    let connected = false
    // Writes stay disarmed until the current restore settles, so a transient read error or an account switch can never clobber a good cloud backup
    let restored = false
    let pending = false
    let latest: Persisted[] = []
    let timer: number | undefined
    let restoreTimer: number | undefined
    // A restore pass parks on broker calls that can take seconds. Meanwhile an account
    // change, or its own retry, can start another one. Without a generation stamp the
    // stale pass resumes against shared state and finishes the job for the wrong account:
    // importing one library into another's, or clearing the list the new pass just filled
    // and uploading the empty result. Only the newest pass is allowed to act.
    let generation = 0
    // Which account the armed writes belong to. The debounce fires up to 3s after the
    // pass that armed it, so the write itself has to re-check, not just the restore.
    let writesFor: string | null = null
    // The unlock card is modal inside the broker frame; offer it once, not once a minute.
    let promptedUnlock = false

    const currentAccount = (): string | null => {
      try { return localStorage.getItem(ACCOUNT_KEY) } catch { return null }
    }

    const writeNow = () => {
      pending = false
      window.clearTimeout(timer)
      // Sync only the device-portable identity, never device-local state like
      // `started` or `paused` (whether this device has the files, and whether the user
      // stopped it here), so one device can't reach into another's copy of the entry.
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
        // The scope can lock after the restore settled: a key epoch reset, or the broker
        // frame losing the key. Offer the card once and retry the write, so sync recovers
        // without waiting for a remount. One retry only, so a persistent lock cannot loop.
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
    // Fire a pending write before the page or route goes away, so the last change
    // inside the debounce window still reaches the cloud (best-effort on pagehide).
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
      // null means the broker never answered, which is not the same as "signed out": a
      // timeout used to leave sync silently off with nothing scheduled to try again.
      let available: boolean | null = null
      try { available = await bounded<boolean | null>(cloud.fs.available().then(Boolean), null) } catch {}
      if (stale()) return
      if (available === null) { setStatus('error'); retryLater(attempt); return }
      connected = available
      if (!connected) { setStatus('off'); return }

      const name = await accountName()
      if (stale()) return
      // account.info() resolves null on a timeout and on any broker error alike, so a
      // null name is "we do not know who this is", not "nobody". A device that has synced
      // before has an identity to match: without one, the local list cannot be attributed
      // to the connected account, and merging it into that account's backup would hand
      // one user's library to another. Import nothing, keep writes disarmed, try again.
      if (name === null && currentAccount() !== null) { setStatus('error'); retryLater(attempt); return }

      setStatus('syncing')
      let text: string | null = null
      let missing = false
      let locked = false
      try {
        const read = await bounded<string | null>(cloud.fs.promises.readFile(BACKUP_PATH, 'utf8').then(String), null)
        // A timed-out read is transient, not an absent backup: fall through to the retry.
        if (read === null) throw new Error('broker timed out')
        text = read
      } catch (err) {
        // A definitive "not found" means there is no backup, and unreadable bytes mean there
        // is no usable one; both are safe to seed over. Locked gets its own recovery below.
        // Anything else is transient and must never seed over a backup that may still be good.
        missing = /not found/i.test((err as { message?: string })?.message ?? '') || isUnreadable(err)
        locked = isLocked(err)
      }
      if (stale()) return

      if (locked) {
        // The unlock card needs a real click inside the broker's own frame, so this is the
        // only way back from a locked scope. Offer it once per mount and never again: the
        // read itself is what raises the card, so a retrying read would put a dialog in
        // front of the user every minute for the rest of the session. The backoff keeps
        // running underneath, so a scope unlocked by other means still recovers on its own.
        if (!promptedUnlock) {
          promptedUnlock = true
          try { await bounded(cloud.fs.unlock(), false) } catch {}
          if (stale()) return
        }
        setStatus('error')
        retryLater(attempt)
        return
      }

      // The list on this device belongs to whichever account was last synced. If that is
      // not the one connected now, it must not be uploaded into this account's backup. Drop
      // it only once this account's backup has actually been read, so a rename (the display
      // name is the only identity the account surface exposes) or a passing read failure
      // cannot destroy a library it would then have nothing to restore from.
      const previous = currentAccount()
      const switched = !!name && !!previous && previous !== name
      if (switched && text === null && !missing) {
        // Unverifiable: keep the local list, keep writes disarmed, and try again.
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
          // A restorable backup - even an empty one - means a returning user, so
          // suppress the demo and never let it re-pollute an emptied library.
          try { localStorage.setItem(DEMO_SEEDED_KEY, '1') } catch {}
          if (list.length) client.importList(list)
        }
        restored = true
        setStatus('synced')
        // The local list can be a superset of the backup (anything added while signed out),
        // and importList posts nothing when it merges no new entry, so this is the only
        // chance to notice. Arm a write and let the debounce collapse it with any import.
        if (latest.length) schedule()
      } else if (missing) {
        // No backup for this account, or one that can never be decrypted here: seed it with
        // the current local list. Re-seeding replaces an unreadable object, which is the only
        // way sync recovers, since nothing can read those bytes back.
        restored = true
        setStatus('synced')
        if (latest.length) schedule()
      } else {
        // Transient read failure: keep writes disarmed (restored stays false) so nothing clobbers a
        // possibly-good backup, surface the error, and keep retrying on a widening backoff.
        setStatus('error')
        retryLater(attempt)
      }
    }

    let offAccount: (() => void) | undefined
    account.onChange(() => { if (!cancelled) restore() })
      .then((off) => { if (cancelled) off(); else offAccount = off })
      .catch(() => {})
    restore().finally(() => settle())

    // A restore that failed while the connection was down should not wait out its backoff.
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
