import type { Torrent } from '../torrent/types'

import { defineMessages } from 'react-intl'

import { intl } from '../i18n'
import { writeDuration } from '../torrent/uptime'
import { getHumanReadableSpeed } from '../utils/bytes'

/**
 * The few strings both views of the library need.
 *
 * A file of its own because `home.tsx` imports the table and the table would otherwise import back
 * from `home.tsx` for these. Small, but a cycle through a 3000 line module is not a small problem.
 */

export const STATE_LABEL = defineMessages<Torrent['state']>({
  downloading: { id: 'Downloading', defaultMessage: 'Downloading' },
  seeding: { id: 'Seeding', defaultMessage: 'Seeding' },
  paused: { id: 'Paused', defaultMessage: 'Paused' },
  queued: { id: 'Queued', defaultMessage: 'Queued' },
  done: { id: 'Done', defaultMessage: 'Done' },
  error: { id: 'Error', defaultMessage: 'Error' },
  missing: { id: 'Files missing', defaultMessage: 'Files missing' },
  retrying: { id: 'Retrying', defaultMessage: 'Retrying' },
  checking: { id: 'Checking', defaultMessage: 'Checking' },
  starting: { id: 'Starting', defaultMessage: 'Starting' },
})

export const speed = (bps: number): string => getHumanReadableSpeed(bps, true)

/**
 * How long ago, in the shortest form that is still true.
 *
 * Hours for today, days for this week, then a date. Unknown renders a plain hyphen, matching what
 * `eta` already produces for the same reason: a zero would be a claim, and this is an absence.
 */
export const relativeDay = (ms: number | undefined, now = Date.now()): string => {
  if (!ms) return '-'
  const days = (now - ms) / 86_400_000
  if (days < 1) return writeDuration({ hours: Math.max(1, Math.round(days * 24)) })
  if (days < 7) return writeDuration({ days: Math.round(days) })
  const d = new Date(ms)
  return intl.formatDate(
    d,
    d.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: '2-digit', month: 'short', day: 'numeric' },
  )
}

export const retryLine = (t: Torrent, retry: NonNullable<Torrent['retry']>): string => {
  /**
   * `stopped` does NOT mean an error happened, and this used to say it did.
   *
   * recovery.ts sets that reason from `status.paused` alone: it means the engine has this torrent
   * stopped and Ripple did not ask it to. An actual fault arrives separately, as `retry.message`
   * carrying libtorrent's own error text, and is preferred below whenever there is one. So the
   * fallback is reached precisely when there is NO error, and "Stopped by an error" was therefore a
   * claim contradicted by the very field that would have carried it. Reported as a bug by somebody
   * who went looking in the console and correctly found nothing.
   */
  const stalled = retry.reason === 'stalled'
    ? (t.peers > 0
      ? intl.formatMessage({ id: 'Peers stopped sending data', defaultMessage: 'Peers stopped sending data' })
      : intl.formatMessage({ id: 'Not connected to any peers', defaultMessage: 'Not connected to any peers' }))
    : intl.formatMessage({ id: 'Stopped unexpectedly', defaultMessage: 'Stopped unexpectedly' })
  const reason = retry.message ?? stalled
  const wait = retry.retryInSeconds <= 0
    ? intl.formatMessage({ id: 'retrying now', defaultMessage: 'retrying now' })
    : intl.formatMessage({ id: 'retrying in {time}', defaultMessage: 'retrying in {time}' }, {
      time: retry.retryInSeconds < 60
        ? writeDuration({ seconds: retry.retryInSeconds })
        : writeDuration({ minutes: Math.ceil(retry.retryInSeconds / 60) }),
    })
  return `${reason} · ${wait}`
}
