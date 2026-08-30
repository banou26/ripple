export type RecoveryReason = 'stopped' | 'stalled'

export type RecoveryState = {
  reason: RecoveryReason
  attempt: number
  retryAt: number
  message?: string
}

export type ObservedStatus = {
  paused: boolean
  state: number
  totalDone: number
  downloadRate: number
  numPeers: number
  queued: boolean
  error: string
}

export type RecoveryAction = { handle: number, reason: RecoveryReason }

const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
const STALL_MS = 120_000
const ACTION_GRACE_MS = 10_000
const HEALTHY_MS = 60_000
// Downloading metadata (2) or downloading (3): only these can be stalled.
const ACTIVE_STATES = new Set([2, 3])
/**
 * Checking files (1) and checking resume data (7), which libtorrent reports as PAUSED while they
 * run. Exported because anything driving the pause flag has to know that, not just this tracker: a
 * loop that reads `paused` as something to correct would fight a check for its whole run.
 */
export const CHECKING_STATES = new Set([1, 7])

type Entry = RecoveryState & {
  healthySince: number | null
  graceUntil: number
}

export type RecoveryTracker = {
  observe: (handle: number, status: ObservedStatus | null, userPaused: boolean, now: number) => void
  hold: (handle: number, now: number, ms?: number) => void
  due: (now: number) => RecoveryAction[]
  retryNow: (now: number) => void
  retry: (handle: number, now: number) => void
  state: (handle: number) => RecoveryState | null
  forget: (handle: number) => void
  retain: (handles: Set<number>) => void
}

export const createRecoveryTracker = (): RecoveryTracker => {
  const entries = new Map<number, Entry>()
  const progress = new Map<number, { totalDone: number, at: number }>()
  const messages = new Map<number, string>()
  const held = new Map<number, number>()

  const delayFor = (attempt: number) => RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]!

  const forget = (handle: number) => {
    entries.delete(handle)
    progress.delete(handle)
    messages.delete(handle)
    held.delete(handle)
  }

  return {
    // a status update is up to a tick behind the command that caused it, so a torrent just resumed still reports itself paused, and judging that would flash
    // "Retrying" over a torrent doing exactly as told
    hold: (handle, now, ms = ACTION_GRACE_MS) => held.set(handle, now + ms),

    observe: (handle, status, userPaused, now) => {
      if (userPaused) { forget(handle); return }
      if (!status) return

      const until = held.get(handle)
      if (until !== undefined) {
        if (now < until) return
        held.delete(handle)
      }

      const seen = progress.get(handle)
      if (!seen || status.totalDone > seen.totalDone) progress.set(handle, { totalDone: status.totalDone, at: now })
      const since = progress.get(handle)!.at

      if (CHECKING_STATES.has(status.state)) return

      const entry = entries.get(handle)
      // Recorded before the grace check so an explanation arriving mid-retry is not thrown away.
      if (status.error) {
        messages.set(handle, status.error)
        if (entry) entry.message = status.error
      }
      if (entry && now < entry.graceUntil) return

      // A torrent the queue parked is neither failing nor proof of health: falling through to the healthy branch would forget a real failure.
      if (status.paused && status.queued) return

      const failure: RecoveryReason | null =
        status.paused
          ? 'stopped'
          // No peers as well as no bytes: a magnet still fetching metadata holds totalDone at 0, and the kick disconnects every peer.
          : ACTIVE_STATES.has(status.state) && status.numPeers === 0 && status.downloadRate === 0 && now - since >= STALL_MS
            ? 'stalled'
            : null

      if (!failure) {
        if (!entry) return
        entry.healthySince ??= now
        if (now - entry.healthySince >= HEALTHY_MS) forget(handle)
        return
      }

      if (!entry) {
        entries.set(handle, {
          reason: failure,
          attempt: 0,
          retryAt: now + delayFor(0),
          message: messages.get(handle),
          healthySince: null,
          graceUntil: 0,
        })
        return
      }
      entry.reason = failure
      if (entry.healthySince !== null) {
        entry.healthySince = null
        entry.retryAt = now + delayFor(entry.attempt)
      }
    },

    due: (now) => {
      const actions: RecoveryAction[] = []
      for (const [handle, entry] of entries) {
        if (entry.healthySince !== null || now < entry.retryAt) continue
        entry.attempt++
        entry.retryAt = now + delayFor(entry.attempt)
        entry.graceUntil = now + ACTION_GRACE_MS
        actions.push({ handle, reason: entry.reason })
      }
      return actions
    },

    retryNow: (now) => {
      for (const entry of entries.values()) {
        if (entry.healthySince !== null) continue
        entry.attempt = 0
        entry.retryAt = now
      }
    },

    retry: (handle, now) => {
      const entry = entries.get(handle)
      if (!entry) return
      entry.attempt = 0
      entry.retryAt = now
      entry.healthySince = null
      entry.graceUntil = 0
      held.delete(handle)
    },

    state: (handle) => {
      const entry = entries.get(handle)
      if (!entry || entry.healthySince !== null) return null
      return { reason: entry.reason, attempt: entry.attempt, retryAt: entry.retryAt, message: entry.message }
    },

    forget,

    retain: (handles) => {
      for (const map of [entries, progress, messages, held]) {
        for (const handle of [...map.keys()]) if (!handles.has(handle)) forget(handle)
      }
    },
  }
}
