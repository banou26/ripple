import type { Torrent } from '../torrent/types'

import { useCallback, useState } from 'react'

/**
 * The torrents ticked for one action on several at once, apart from the one row the detail panel shows.
 *
 * Keyed by info hash, never by row id: a live row's id is a libtorrent handle, which names another
 * torrent once the engine moves to another tab, so a selection kept by id would aim a removal at the
 * wrong rows after a handover.
 */
export type Picked = ReadonlySet<string>

const NONE: Picked = new Set()

/** A row that can be ticked: it has an info hash, and the engine has reported it so a command can reach it. */
export const pickable = (t: Torrent): t is Torrent & { infoHash: string } =>
  !!t.infoHash && t.state !== 'starting'

/** The ticked rows among `rows`, which are the ones a bulk action counts and acts on. */
export const pickedRows = (rows: readonly Torrent[], picked: Picked) =>
  rows.filter((t): t is Torrent & { infoHash: string } => pickable(t) && picked.has(t.infoHash))

export const togglePick = (picked: Picked, infoHash: string): Picked => {
  const next = new Set(picked)
  if (!next.delete(infoHash)) next.add(infoHash)
  return next
}

/** Every row that can be ticked among those shown, so a filter decides what "all" means. */
export const pickAll = (shown: readonly Torrent[]): Picked => new Set(shown.filter(pickable).map((t) => t.infoHash))

/**
 * The selection less every torrent no longer shown, or `picked` itself when none went.
 *
 * A torrent removed anywhere, or hidden by a filter, leaves it. A row that is `starting` again keeps
 * its place, so a selection outlives the second a handover takes.
 */
export const keepShown = (picked: Picked, shown: readonly (string | undefined)[]): Picked => {
  const present = new Set(shown)
  return [...picked].every((h) => present.has(h)) ? picked : new Set([...picked].filter((h) => present.has(h)))
}

export const useBulkSelection = (shown: readonly Torrent[]) => {
  const [held, setPicked] = useState<Picked>(NONE)
  // adjusted while rendering rather than in an effect, so no frame shows a count that went stale
  const picked = keepShown(held, shown.map((t) => t.infoHash))
  if (picked !== held) setPicked(picked)

  const rows = pickedRows(shown, picked)
  const canPick = shown.some(pickable)
  const all = canPick && rows.length === shown.filter(pickable).length
  const toggle = useCallback((t: Torrent) => { if (pickable(t)) setPicked((prev) => togglePick(prev, t.infoHash)) }, [])
  const clear = useCallback(() => setPicked(NONE), [])
  const toggleAll = () => setPicked(all ? NONE : pickAll(shown))

  return { picked, rows, canPick, all, toggle, toggleAll, clear }
}
