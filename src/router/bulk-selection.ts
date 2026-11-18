import type { Torrent } from '../torrent/types'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { stopped } from '../torrent/types'

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

/** The rows Pause changes: every one not stopped already, as the options menu has it. A ghost has no engine to pause. */
export const toPause = (rows: readonly Torrent[]) => rows.filter((t) => t.state !== 'missing' && !stopped(t))

/** The rows Resume changes: the stopped, as the options menu has it. */
export const toResume = (rows: readonly Torrent[]) => rows.filter(stopped)

/** The rows Download fetches: those not on this device, as the row's own button, so never a created source. */
export const toStart = (rows: readonly Torrent[]) => rows.filter((t) => t.state === 'missing' && t.saveTo !== 'source')

export const togglePick = (picked: Picked, infoHash: string): Picked => {
  const next = new Set(picked)
  if (!next.delete(infoHash)) next.add(infoHash)
  return next
}

/**
 * The selection after a click on the box of `clicked`, with `anchor` the box clicked before it, or null.
 *
 * With the anchor among `drawn`, which is the list in the order it is drawn, every row that can be ticked from the
 * anchor to `clicked`, both included, takes the state the clicked box takes. With no anchor, or one no longer drawn, the
 * click ticks or unticks `clicked` alone.
 */
export const pickRun = (picked: Picked, drawn: readonly Torrent[], anchor: string | null, clicked: string): Picked => {
  const from = drawn.findIndex((t) => t.infoHash === anchor)
  const to = drawn.findIndex((t) => t.infoHash === clicked)
  if (from < 0 || to < 0) return togglePick(picked, clicked)
  const tick = !picked.has(clicked)
  const next = new Set(picked)
  for (const t of drawn.slice(Math.min(from, to), Math.max(from, to) + 1).filter(pickable)) {
    if (tick) next.add(t.infoHash)
    else next.delete(t.infoHash)
  }
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

/** `shown` is the list in the order it is drawn, which is the order a shift+click's run follows. */
export const useBulkSelection = (shown: readonly Torrent[]) => {
  const [held, setPicked] = useState<Picked>(NONE)
  // adjusted while rendering rather than in an effect, so no frame shows a count that went stale
  const picked = keepShown(held, shown.map((t) => t.infoHash))
  if (picked !== held) setPicked(picked)
  const drawn = useRef(shown)
  const anchor = useRef<string | null>(null)
  useLayoutEffect(() => {
    drawn.current = shown
    // the box clicked last, let go of once its row leaves the list, as its tick is
    if (!shown.some((t) => t.infoHash === anchor.current)) anchor.current = null
  })

  const rows = pickedRows(shown, picked)
  const canPick = shown.some(pickable)
  const all = canPick && rows.length === shown.filter(pickable).length
  /** A click on `t`'s box, which with `shift` ticks or unticks the run from the box clicked before it. */
  const toggle = useCallback((t: Torrent, shift = false) => {
    if (!pickable(t)) return
    const from = shift ? anchor.current : null
    const list = drawn.current
    anchor.current = t.infoHash
    setPicked((prev) => pickRun(prev, list, from, t.infoHash))
  }, [])
  const clear = useCallback(() => setPicked(NONE), [])
  const toggleAll = () => setPicked(all ? NONE : pickAll(shown))

  return { picked, rows, canPick, all, toggle, toggleAll, clear }
}
