// Why a torrent stopped making progress, and when to try it again.
//
// Two failures leave a torrent dead in the water and neither heals on its own:
//
//   stopped   libtorrent stops a torrent outright when a disk read or write fails.
//             It stays stopped until something resumes it.
//   stalled   the connection dropped, so every peer went away. libtorrent reconnects
//             on its own schedule, but the next tracker announce can be half an hour
//             out, so a torrent can sit at zero for a long time after the network is
//             back. Stopping and restarting it forces a fresh announce.
//
// This tracks both per torrent and schedules a retry on a widening backoff. The attempt
// counter only resets once a torrent has run healthily for a while, so a torrent that
// keeps failing backs off instead of retrying every few seconds forever.

export type RecoveryReason = 'stopped' | 'stalled'

export type RecoveryState = {
  reason: RecoveryReason
  // How many retries have already been spent on this failure.
  attempt: number
  // Epoch ms of the next retry.
  retryAt: number
  // The libtorrent alert that explains the failure, when one could be attributed.
  message?: string
}

export type ObservedStatus = {
  paused: boolean
  state: number
  totalDone: number
  downloadRate: number
  numPeers: number
  // libtorrent's own queue is holding this torrent behind others: it stops whatever sits
  // past active_downloads / active_seeds to make room, and starts it again itself once a
  // slot frees. Reported by the engine rather than guessed at, so it is never a failure.
  queued: boolean
  // The engine's description of the error that stopped this torrent, empty when it has
  // none. It arrives attached to the torrent it belongs to, so no explanation is ever
  // credited to the wrong one.
  error: string
}

export type RecoveryAction = { handle: number, reason: RecoveryReason }

// 5s, 15s, 30s, 1m, 2m, then every 5m. Short enough that a passing blip costs seconds,
// long enough that a torrent whose tracker is down does not hammer it.
const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
// Downloading, nothing arriving, and nothing has landed for this long: the swarm is gone.
const STALL_MS = 120_000
// After a retry, give the engine time to act before judging the same torrent again.
const ACTION_GRACE_MS = 10_000
// Healthy for this long and the next failure starts from the shortest delay again.
const HEALTHY_MS = 60_000
// Only a torrent that should be pulling bytes can be stalled: downloading metadata (2)
// or downloading (3). Finished, seeding and checking states are quiet on purpose.
const ACTIVE_STATES = new Set([2, 3])
// Checking files (1) and checking resume data (7) are legitimate busy states that
// libtorrent reports as paused while they run. Judging one would restart a check that
// is going fine, and it can take minutes on a large torrent.
const CHECKING_STATES = new Set([1, 7])

type Entry = RecoveryState & {
  // Set while the torrent is running again; it is only forgotten (and the backoff
  // reset) once it has stayed that way for HEALTHY_MS.
  healthySince: number | null
  graceUntil: number
}

export type RecoveryTracker = {
  // Feed one torrent's latest status. `userPaused` torrents are never a failure.
  observe: (handle: number, status: ObservedStatus | null, userPaused: boolean, now: number) => void
  // Ignore this torrent's status for a moment. A status update is up to a tick behind the
  // command that caused it, so a torrent that was just resumed still reports itself as
  // paused, and judging that would flash "Retrying" over a torrent doing exactly as told.
  hold: (handle: number, now: number, ms?: number) => void
  // The retries that are due now. Calling this spends the attempt and reschedules.
  due: (now: number) => RecoveryAction[]
  // Connectivity came back: every waiting torrent gets retried immediately, and the
  // backoff restarts short because the failures so far were all the same outage.
  retryNow: (now: number) => void
  // The user asked for one torrent to be retried now. Deliberately routed through the
  // same schedule rather than acting directly, so the action taken still matches the
  // recorded reason: a stalled torrent is not paused, so resuming it does nothing.
  retry: (handle: number, now: number) => void
  state: (handle: number) => RecoveryState | null
  forget: (handle: number) => void
  retain: (handles: Set<number>) => void
}

export const createRecoveryTracker = (): RecoveryTracker => {
  const entries = new Map<number, Entry>()
  // Last point at which each torrent's totalDone moved, for the stall check.
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
    hold: (handle, now, ms = ACTION_GRACE_MS) => held.set(handle, now + ms),

    observe: (handle, status, userPaused, now) => {
      // An explicit pause is a choice, not a failure, and it must never be undone here.
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
      // Recorded before the grace check so an explanation that arrives while the engine is
      // still acting on a retry is not thrown away.
      if (status.error) {
        messages.set(handle, status.error)
        if (entry) entry.message = status.error
      }
      if (entry && now < entry.graceUntil) return

      // A torrent the queue parked is neither failing nor proof of health. Returning here
      // rather than falling through to the healthy branch is the point: treating it as
      // healthy would heal, and then forget, an entry that belongs to a real failure, and
      // the manual retry would have nothing left to act on.
      if (status.paused && status.queued) return

      const failure: RecoveryReason | null =
        status.paused
          ? 'stopped'
          // No peers as well as no bytes. A torrent whose peers are all choking it, and a
          // magnet still fetching metadata (where totalDone stays 0 and the transfer is
          // counted as protocol, not payload), are both working and must not be kicked:
          // the kick disconnects every peer, which is how a slow metadata fetch would
          // never finish at all.
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
      // Failing again before it earned a reset: keep the attempt count, restart the wait.
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

    // Keeps the entry, its reason and its message: only the schedule moves. Dropping the
    // entry instead would lose the stall clock too, pushing the real retry minutes out.
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
