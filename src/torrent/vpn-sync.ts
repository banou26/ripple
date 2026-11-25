import { useEffect } from 'react'
import { get, update } from 'idb-keyval'
import { account, cloud } from '@fkn/lib'

import { setVpn } from './client'
import { accountTag } from './groups'
import { vpnOffAvailable, vpnOn } from './vpn-setting'

export const VPN_SYNC_PATH = 'ripple/vpn.json'
export const VPN_SYNC_KEY = 'ripple:vpn-sync'

const BROKER_TIMEOUT = 10_000
const ACCOUNT_TIMEOUT = 4_000
const FOCUS_COOLDOWN_MS = 1_500
const SIGNED_OUT_COOLDOWN_MS = 30_000
const POLL_INTERVAL_MS = 30_000
const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000]
const MAX_RERUNS = 3

const sameStored = (a: StoredVpnSync | undefined, b: StoredVpnSync | undefined): boolean =>
  a === b || (!!a && !!b && a.account === b.account && a.on === b.on && a.updatedAt === b.updatedAt)

export type VpnSyncRecord = { on: boolean, updatedAt: number }
export type StoredVpnSync = { account: string | null, on: boolean, updatedAt: number }
export type VpnSyncResolution = { record: StoredVpnSync, applyLocal: boolean, writeCloud: boolean }
export type VpnSyncOutcome = 'disabled' | 'signed-out' | 'locked' | 'stale' | 'retry' | 'synced'

export type VpnSyncDeps = {
  vpnOffAvailable: () => boolean
  vpnOn: () => boolean
  setVpn: (on: boolean) => Promise<void>
  accountInfo: () => Promise<string | null>
  fsAvailable: () => Promise<boolean | null>
  readCloud: () => Promise<VpnSyncRecord | null | 'absent' | 'locked' | 'error'>
  writeCloud: (record: VpnSyncRecord) => Promise<'ok' | 'locked' | 'error'>
  readStored: () => Promise<StoredVpnSync | undefined>
  writeStored: (updater: (prev: StoredVpnSync | undefined) => StoredVpnSync | undefined) => Promise<void>
  tagAccount: (name: string) => Promise<string | null>
  now: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parses a cloud `ripple/vpn.json` payload, returning null for any malformed or missing shape. */
export const parseVpnSync = (raw: unknown): VpnSyncRecord | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.on !== 'boolean') return null
  if (!Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0) return null
  return { on: raw.on, updatedAt: raw.updatedAt as number }
}

/**
 * Reconciles the local VPN choice (`localOn`, `stored`) against the account's cloud copy (`remote`)
 * by latest `updatedAt`, preferring `on: true` on ties and dropping another account's prior choice.
 */
export const resolveVpnSync = ({
  account: accountId,
  localOn,
  stored,
  remote,
  now = Date.now(),
}: {
  account: string
  localOn: boolean
  stored: StoredVpnSync | undefined
  remote: VpnSyncRecord | null
  now?: number
}): VpnSyncResolution => {
  if (stored?.account && stored.account !== accountId) {
    if (remote !== null) {
      return {
        record: { account: accountId, on: remote.on, updatedAt: remote.updatedAt },
        applyLocal: remote.on !== localOn,
        writeCloud: false,
      }
    }
    return {
      record: { account: accountId, on: true, updatedAt: 0 },
      applyLocal: localOn !== true,
      writeCloud: false,
    }
  }

  let local: VpnSyncRecord
  if (stored && stored.on === localOn) {
    local = { on: stored.on, updatedAt: stored.updatedAt }
  } else if (!localOn) {
    local = { on: false, updatedAt: remote === null ? now : 0 }
  } else {
    local = { on: true, updatedAt: 0 }
  }

  if (remote === null) {
    if (local.updatedAt > 0) {
      return {
        record: { account: accountId, on: local.on, updatedAt: local.updatedAt },
        applyLocal: false,
        writeCloud: true,
      }
    }
    return {
      record: { account: accountId, on: true, updatedAt: 0 },
      applyLocal: false,
      writeCloud: false,
    }
  }

  if (local.updatedAt > remote.updatedAt) {
    return {
      record: { account: accountId, on: local.on, updatedAt: local.updatedAt },
      applyLocal: false,
      writeCloud: true,
    }
  }
  if (remote.updatedAt > local.updatedAt) {
    return {
      record: { account: accountId, on: remote.on, updatedAt: remote.updatedAt },
      applyLocal: remote.on !== localOn,
      writeCloud: false,
    }
  }

  if (local.on === remote.on) {
    return {
      record: { account: accountId, on: remote.on, updatedAt: remote.updatedAt },
      applyLocal: false,
      writeCloud: false,
    }
  }
  if (local.on) {
    return {
      record: { account: accountId, on: true, updatedAt: local.updatedAt },
      applyLocal: false,
      writeCloud: true,
    }
  }
  return {
    record: { account: accountId, on: true, updatedAt: remote.updatedAt },
    applyLocal: localOn !== true,
    writeCloud: false,
  }
}

const isLocked = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'FKN_E2E_LOCKED'

const isAbsent = (err: unknown, message: string): boolean =>
  cloud.fs?.isNotFound?.(err) === true
  || (err as { code?: string } | null)?.code === 'FKN_STORAGE_NOT_FOUND'
  || /not found/i.test(message)
  || /\(404\)/.test(message)

const isUnreadable = (err: unknown): boolean => {
  const message = (err as { message?: string } | null)?.message ?? ''
  return message.startsWith('fkn:e2e-integrity') || message.startsWith('fkn:e2e-stale-epoch')
}

const bounded = <T>(work: Promise<T>, fallback: T, ms = BROKER_TIMEOUT): Promise<T> => {
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('broker timed out')), ms)
  })
  return Promise.race([work, timeout])
    .finally(() => { if (timer !== undefined) clearTimeout(timer) })
    .catch((err) => {
      if ((err as Error | null)?.message === 'broker timed out') return fallback
      throw err
    })
}

/**
 * Serialized state controller that reconciles local IDB/localStorage VPN state with `cloud.fs`,
 * keeping mid-flight user clicks and account switches from being overwritten by stale cloud reads.
 */
export const createVpnSyncController = (deps: VpnSyncDeps) => {
  let accountGen = 0
  let choiceSeq = 0
  let lastSeenRemoteAt = 0
  let inFlight: Promise<VpnSyncOutcome> | null = null
  let rerun = false
  let recordQueue: Promise<void> = Promise.resolve()

  const runOnce = async (): Promise<VpnSyncOutcome> => {
    if (!deps.vpnOffAvailable()) return 'disabled'
    const gen = accountGen
    const seqAtStart = choiceSeq

    const [available, name] = await Promise.all([deps.fsAvailable(), deps.accountInfo()])
    if (gen !== accountGen) return 'stale'
    if (available !== true) return available === null || name !== null ? 'retry' : 'signed-out'
    if (!name) return 'retry'

    const cloudRead = await deps.readCloud()
    if (gen !== accountGen) return 'stale'
    if (cloudRead === 'locked') return 'locked'
    if (cloudRead === 'error') return 'retry'
    const remote = cloudRead === 'absent' ? null : cloudRead
    if (remote !== null) lastSeenRemoteAt = Math.max(lastSeenRemoteAt, remote.updatedAt)

    const tag = await deps.tagAccount(name)
    if (gen !== accountGen || !tag) return 'stale'

    const clickedDuringRead = seqAtStart !== choiceSeq
    const seqBeforeLocal = choiceSeq
    const [storedRead, localOn] = await Promise.all([
      deps.readStored().catch(() => undefined),
      Promise.resolve(deps.vpnOn()),
    ])
    let stored = storedRead
    if (gen !== accountGen || seqBeforeLocal !== choiceSeq) {
      rerun = true
      return 'stale'
    }
    // A deliberate user click made while this cloud read was in flight must beat any skewed remote clock
    if (clickedDuringRead && stored && remote && stored.updatedAt <= lastSeenRemoteAt) {
      const bumped: StoredVpnSync = { ...stored, updatedAt: lastSeenRemoteAt + 1 }
      let bumpOvertaken = false
      await deps.writeStored((current) => {
        if (!sameStored(current, stored)) {
          bumpOvertaken = true
          return current
        }
        return bumped
      }).catch(() => {})
      if (bumpOvertaken || gen !== accountGen || seqBeforeLocal !== choiceSeq) { rerun = true; return 'stale' }
      stored = bumped
    }

    const res = resolveVpnSync({ account: tag, localOn, stored, remote, now: deps.now() })

    if (res.writeCloud) {
      if (gen !== accountGen || seqBeforeLocal !== choiceSeq) {
        rerun = true
        return 'stale'
      }
      const wrote = await deps.writeCloud({ on: res.record.on, updatedAt: res.record.updatedAt })
      if (wrote === 'locked') return 'locked'
      if (wrote === 'error') return 'retry'
    }

    if (gen !== accountGen) return 'stale'
    let overtaken = seqBeforeLocal !== choiceSeq
    if (!overtaken && (stored !== undefined || res.record.updatedAt > 0 || !res.record.on || res.applyLocal)) {
      await deps.writeStored((current) => {
        if (seqBeforeLocal !== choiceSeq || !sameStored(current, stored)) {
          overtaken = true
          return current
        }
        return res.record
      }).catch(() => {})
    }
    if (overtaken || gen !== accountGen || seqBeforeLocal !== choiceSeq) {
      if (overtaken || seqBeforeLocal !== choiceSeq) rerun = true
      return 'stale'
    }

    if (res.applyLocal) await deps.setVpn(res.record.on)
    return 'synced'
  }

  const sync = (): Promise<VpnSyncOutcome> => {
    if (inFlight) {
      rerun = true
      return inFlight
    }
    const run = (async (): Promise<VpnSyncOutcome> => {
      let last: VpnSyncOutcome = 'synced'
      let attempts = 0
      do {
        rerun = false
        last = await runOnce()
        attempts += 1
      } while (rerun && attempts < MAX_RERUNS)
      return last
    })().finally(() => { inFlight = null })
    inFlight = run
    return run
  }

  const recordChoice = async (on: boolean): Promise<VpnSyncOutcome> => {
    if (!deps.vpnOffAvailable()) return 'disabled'
    choiceSeq += 1
    const stamp = Math.max(deps.now(), lastSeenRemoteAt + 1)
    recordQueue = recordQueue.then(() =>
      deps.writeStored((prev) => ({
        account: prev?.account ?? null,
        on,
        updatedAt: Math.max(stamp, (prev?.updatedAt ?? 0) + 1),
      })).catch(() => {})
    )
    await recordQueue
    return sync()
  }

  const noteAccountSwitch = () => { accountGen += 1; lastSeenRemoteAt = 0 }

  return { sync, recordChoice, noteAccountSwitch }
}

const defaultController = createVpnSyncController({
  vpnOffAvailable,
  vpnOn,
  setVpn,
  accountInfo: () => bounded(account.info().then((info) => info?.name ?? null), null, ACCOUNT_TIMEOUT).catch(() => null),
  fsAvailable: () => bounded<boolean | null>(cloud.fs.available().then(Boolean), null, BROKER_TIMEOUT).catch(() => null),
  readCloud: async () => {
    let text: string | null = null
    try {
      text = await bounded<string | null>(cloud.fs.promises.readFile(VPN_SYNC_PATH, 'utf8').then(String), null)
    } catch (err) {
      if (isLocked(err)) return 'locked'
      const msg = (err as { message?: string } | null)?.message ?? String(err)
      if (isAbsent(err, msg) || isUnreadable(err)) return 'absent'
      return 'error'
    }
    if (text === null) return 'error'
    try { return parseVpnSync(JSON.parse(text)) } catch { return 'absent' }
  },
  writeCloud: async (record) => {
    try {
      await bounded(
        cloud.fs.promises.writeFile(VPN_SYNC_PATH, JSON.stringify(record), { contentType: 'application/json' }).then(() => true),
        false,
      ).then((ok) => { if (!ok) throw new Error('write timed out') })
      return 'ok'
    } catch (err) {
      return isLocked(err) ? 'locked' : 'error'
    }
  },
  readStored: () => get<StoredVpnSync>(VPN_SYNC_KEY),
  writeStored: (updater) => update<StoredVpnSync | undefined>(VPN_SYNC_KEY, updater),
  tagAccount: accountTag,
  now: () => Date.now(),
})

/** Stamps a user-initiated VPN toggle locally and pushes it to `cloud.fs` when signed in. */
export const recordVpnChoice = (on: boolean): Promise<VpnSyncOutcome> => defaultController.recordChoice(on)

/** Runs one signed-in VPN sync pass against `cloud.fs`. */
export const syncVpnSetting = (): Promise<VpnSyncOutcome> => defaultController.sync()

/** Keeps every Ripple partition (top-level or embedded) synced with the signed-in account's VPN setting. */
export const useVpnCloudSync = (): void => {
  useEffect(() => {
    if (!vpnOffAvailable()) return
    let cancelled = false
    let lastCheckAt = 0
    let lastSignedOut = false
    let retryAttempt = 0
    let retryPending = false
    let retryTimer: number | undefined
    let offAccount: (() => void) | undefined

    const trigger = (force = false) => {
      if (cancelled) return
      const now = Date.now()
      const cooldown = lastSignedOut ? SIGNED_OUT_COOLDOWN_MS : FOCUS_COOLDOWN_MS
      if (!force && lastCheckAt > 0 && now - lastCheckAt < cooldown) return
      lastCheckAt = now
      window.clearTimeout(retryTimer)
      void defaultController.sync().then((outcome) => {
        if (cancelled) return
        if (outcome === 'retry') {
          lastSignedOut = false
          const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)] ?? 30_000
          retryAttempt += 1
          window.clearTimeout(retryTimer)
          if (document.visibilityState === 'hidden') {
            retryPending = true
            return
          }
          retryPending = false
          retryTimer = window.setTimeout(() => {
            if (cancelled) return
            if (document.visibilityState === 'hidden') {
              retryPending = true
              return
            }
            trigger(true)
          }, delay)
          return
        }
        retryAttempt = 0
        retryPending = false
        lastSignedOut = outcome === 'signed-out'
      })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const due = retryPending
        retryPending = false
        trigger(due)
      }
    }
    const onFocus = () => { trigger(false) }
    const onOnline = () => { trigger(true) }

    account.onChange((change?: { switched?: boolean }) => {
      if (cancelled) return
      if (change?.switched) defaultController.noteAccountSwitch()
      trigger(true)
    })
      .then((off) => { if (cancelled) off(); else offAccount = off })
      .catch(() => {})

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !lastSignedOut) trigger(false)
    }, POLL_INTERVAL_MS)

    trigger(true)

    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      window.clearInterval(pollTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      offAccount?.()
    }
  }, [])
}

export const VpnCloudSync = () => { useVpnCloudSync(); return null }
