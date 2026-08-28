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

/**
 * Which of the several ways this can go is the one that went, because from outside they are
 * identical and none of them says what to do about it.
 *
 * Every terminal state here used to render as one of two things: the words "Sync failed", or
 * nothing at all. Six distinct causes shared the first and two shared the second, so a report of
 * "my library says sync failed" narrowed it down to six code paths and a report of silence
 * narrowed it down to nothing whatsoever, since silence is also what a user who never signed in
 * correctly sees.
 */
export type SyncReason =
  /** No account, so there is nowhere to sync to and nothing is wrong. */
  | 'signed-out'
  /** Signed in, but no storage grant came back. Transient far more often than not: see `restore`. */
  | 'no-storage-grant'
  /** The broker did not answer at all within the bound. */
  | 'broker-timeout'
  /** Signed in, and the account did not name itself, so a merge could hand one library to another. */
  | 'account-unknown'
  /** The storage scope is locked and the unlock did not take. */
  | 'locked'
  /** The backup exists and could not be read, which is never a reason to overwrite it. */
  | 'read-failed'
  /**
   * The broker did not answer the read inside the bound. Separated from `read-failed` because the
   * two want opposite responses: a real read error is about storage, while this is usually the
   * broker being starved by whatever else the tab is doing, and the retry underneath will clear it.
   */
  | 'read-timeout'
  /** The account changed and the new one's backup could not be read, so the local list is held. */
  | 'switch-unverified'
  /** The library was read, and writing it back did not land. */
  | 'write-failed'

export interface SyncState {
  status: SyncStatus
  /** Null while syncing or synced, since neither needs explaining. */
  reason: SyncReason | null
}

/**
 * What a storage-availability answer means for a session that may or may not have an account.
 *
 * `cloud.fs.available()` reads like a static capability check and is not one: it resolves a connect
 * token through the broker and the SharedWorker behind it, and that pull has its own timeout, so a
 * signed-in account with a momentarily unreachable broker answers exactly the same `false` as a
 * user who is not signed in at all.
 *
 * Treating the two alike is what made this terminal. `false` parked the hook on 'off', which
 * schedules no retry and renders nothing, so a transient token pull at page load turned into a
 * library that was silently never backed up for the rest of the session. Nothing re-armed it:
 * `account.onChange` only fires on a change, and the account had not changed.
 *
 * Observed on the live site on 2026-08-16, signed in, Premium, with `account.info()` answering
 * normally and the sync stat absent from the page entirely.
 */
export { isAbsent }

export const classifyAvailability = (
  available: boolean | null,
  signedIn: boolean,
): { connected: boolean, status: SyncStatus, reason: SyncReason | null, retry: boolean } => {
  if (available === null) return { connected: false, status: 'error', reason: 'broker-timeout', retry: true }
  if (available) return { connected: true, status: 'syncing', reason: null, retry: false }
  // The asymmetry is deliberate. Parking is right for a signed-out user and `account.onChange`
  // covers them signing in, so retrying would only add noise. For a signed-in one there is no
  // second event coming, and the retry is a token lookup that costs no network when there is
  // nothing to look up.
  if (signedIn) return { connected: false, status: 'error', reason: 'no-storage-grant', retry: true }
  return { connected: false, status: 'off', reason: 'signed-out', retry: false }
}

// Resolves once the first cloud restore has settled; useTorrents waits on this before deciding to seed the demo
let settle: () => void
export const cloudRestoreSettled = new Promise<void>((resolve) => { settle = resolve })

// The broker reports each with a reserved marker. Only the MESSAGE crosses the osra boundary: it
// boxes an Error as name/message/stack/cause and strips every custom prop, `code` included. The code
// read below is minted in THIS realm by @fkn/lib's storage layer, which matches the broker's message
// and rethrows a typed error (see its storage.ts). So a code is still one thing to test rather than
// two sentences to parse, but it is a local translation, not something that arrived over the wire.
const isLocked = (err: unknown): boolean => (err as { code?: string })?.code === 'FKN_E2E_LOCKED'
/**
 * "There is no backup to read", however the storage layer says it.
 *
 * The CODE is the real answer. @fkn/lib 0.9.17 types absence as `FKN_STORAGE_NOT_FOUND`, which is
 * one thing to test rather than two sentences to parse, and it was added because parsing them is
 * exactly what went wrong here: absence arrives either as `Not found` (the api refusing to presign
 * a path with no committed row) or as `storage: read failed (404)` (the presign succeeding and the
 * object fetch coming back empty). Only the first was matched, so the second read as a transient
 * failure, retried on the backoff forever, and this device's library went un-backed-up for a day
 * reporting nothing but "Sync failed". Measured live on 2026-08-16.
 *
 * The message fallback stays because the code arrives from the fkn.app realm, which is a separate
 * deploy: this page can be running against a data plane older than the lib that types it. Dropping
 * the fallback the day the lib ships would reintroduce the same bug for exactly as long as the
 * other side lagged.
 *
 * Either way the answer must be DEFINITIVE. The rule this file is built on is that anything merely
 * inconclusive never overwrites a backup that may still be good, and an object the store says is
 * not there is not inconclusive.
 */
const isAbsent = (err: unknown, message: string): boolean =>
  (err as { code?: string } | null)?.code === 'FKN_STORAGE_NOT_FOUND'
  || /not found/i.test(message)
  || /\(404\)/.test(message)

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

export const useCloudBackup = (): SyncState => {
  const client = getTorrentClient()
  const [state, setState] = useState<SyncState>({ status: 'off', reason: 'signed-out' })
  // Only the tab hosting the engine syncs: one writer, and it is the tab that owns the library
  const [owned, setOwned] = useState(false)
  useEffect(() => client.onOwnership(setOwned), [client])

  useEffect(() => {
    if (!owned) return
    // every call site names a status and, when it is not a healthy one, why. The log line is what
    // makes the next report of this answerable from a console rather than from six candidate paths.
    const setStatus = (status: SyncStatus, reason: SyncReason | null = null, detail?: string) => {
      setState({ status, reason })
      // The reason names WHICH path; `detail` carries what the layer underneath actually said,
      // because the reason alone leaves a second round of this question to answer. Measured on the
      // live site on 2026-08-16: `read-failed` located the path in one reload and still could not
      // say whether storage had refused the read or simply not answered in time.
      if (reason) console.warn(`[ripple] library sync ${status}: ${reason}${detail ? ` (${detail})` : ''}`)
    }
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
      /*
       * Sync only the device-portable identity, never device-local state: `started`, `paused`, and
       * the cache tier (`ephemeral`, `lastUsedAt`), which describe what THIS browser is holding.
       *
       * The metadata below belongs on that portable side. It says what the torrent IS rather than
       * what this machine has done with it, and without it a second device signed into the same
       * account can only render eight characters of infohash and a size of zero, because all it has
       * is the magnet. `savePath` stays for historical reasons; it is a path, not a machine.
       */
      const portable = latest.map((e) => ({
        infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath, addedAt: e.addedAt,
        name: e.name, size: e.size, files: e.files,
      }))
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
        setStatus('error', 'write-failed')
        // Re-arm, because writeNow cleared `pending` before it threw and this is the only terminal
        // branch with no retry: without it the queued snapshot waits for the next list change or the
        // next mount. @fkn/lib 0.9.22 made this branch newly reachable, by rejecting a call the
        // broker was replaced under instead of leaving it pending forever.
        schedule()
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

      // asked BEFORE the availability is judged, because a `false` means opposite things depending
      // on the answer: no account is the correct resting state, an account is a grant that should
      // be there and is not
      const name = await accountName()
      if (stale()) return

      const verdict = classifyAvailability(available, name !== null)
      connected = verdict.connected
      if (!connected) {
        setStatus(verdict.status, verdict.reason)
        if (verdict.retry) retryLater(attempt)
        return
      }

      // A null name is "we do not know who this is", not "nobody": merging the local list into that account's backup would hand one user's library to another
      if (name === null && currentAccount() !== null) { setStatus('error', 'account-unknown'); retryLater(attempt); return }

      setStatus('syncing')
      let text: string | null = null
      let missing = false
      let locked = false
      let timedOut = false
      let failure = ''
      try {
        const read = await bounded<string | null>(cloud.fs.promises.readFile(BACKUP_PATH, 'utf8').then(String), null)
        // `bounded` reports its own timeout by resolving to the fallback rather than throwing, so
        // this is the ONLY place the two can still be told apart. Folding it into the catch below
        // as a synthetic error is what made a starved broker indistinguishable from storage
        // refusing the read.
        if (read === null) timedOut = true
        else text = read
      } catch (err) {
        failure = (err as { message?: string })?.message ?? String(err)
        // Anything other than a definitive absence or unreadable bytes is transient and must never seed over a backup that may still be good
        missing = isAbsent(err, failure) || isUnreadable(err)
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
        setStatus('error', 'locked')
        retryLater(attempt)
        return
      }

      // The list on this device belongs to whichever account was last synced, so drop it only once this account's backup has actually been read
      const previous = currentAccount()
      const switched = !!name && !!previous && previous !== name
      if (switched && text === null && !missing) {
        setStatus('error', 'switch-unverified')
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
        setStatus('error', timedOut ? 'read-timeout' : 'read-failed', timedOut ? undefined : failure)
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

  return state
}
