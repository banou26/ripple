import type { Torrent } from '../torrent/types'

import { getHumanReadableByteString } from '../utils/bytes'

/**
 * The few strings both views of the library need.
 *
 * A file of its own because `home.tsx` imports the table and the table would otherwise import back
 * from `home.tsx` for these. Small, but a cycle through a 3000 line module is not a small problem.
 */

export const STATE_LABEL: Record<Torrent['state'], string> = {
  downloading: 'Downloading',
  seeding: 'Seeding',
  paused: 'Paused',
  queued: 'Queued',
  done: 'Done',
  error: 'Error',
  missing: 'Files missing',
  retrying: 'Retrying',
  checking: 'Checking',
  starting: 'Starting',
}

export const speed = (bps: number): string => `${getHumanReadableByteString(bps, true)}/s`

/**
 * How long ago, in the shortest form that is still true.
 *
 * Hours for today, days for this week, then a date. Unknown renders a plain hyphen, matching what
 * `eta` already produces for the same reason: a zero would be a claim, and this is an absence.
 */
export const relativeDay = (ms: number | undefined, now = Date.now()): string => {
  if (!ms) return '-'
  const days = (now - ms) / 86_400_000
  if (days < 1) return Math.max(1, Math.round(days * 24)) + 'h'
  if (days < 7) return Math.round(days) + 'd'
  const d = new Date(ms)
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: '2-digit', month: 'short', day: 'numeric' },
  )
}
