import type { Torrent } from '../torrent/types'
import type { ListFilter, SortDir, SortKey } from '../torrent/list-view'

import { useCallback, useRef } from 'react'

import { isVolatile, shouldReorder, sortTorrents, visibleTorrents } from '../torrent/list-view'

/**
 * The visible list, arranged, with the ARRANGEMENT held still for a moment at a time.
 *
 * Sorting by download speed against a feed that ticks twice a second means rows swapping places
 * under the cursor: the Pause button somebody was aiming at moves, and they press the one that
 * arrived instead. So the contents keep updating every tick and only the ORDER is held.
 *
 * All the judgement is in `shouldReorder`, which is pure and tested without timers. What lives here
 * is the bookkeeping: the last order, when it was computed, and whether anybody is touching the list.
 *
 * No timer of its own. The parent already re-renders on every engine broadcast, twice a second, so
 * asking on each render is enough and there is no interval to leak.
 */
export type OrderedTorrents = {
  rows: Torrent[]
  /** Wire to the list container so a held order knows somebody is reaching into it. */
  interaction: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocusCapture: () => void
    onBlurCapture: () => void
  }
}

export const useOrderedTorrents = (
  all: readonly Torrent[],
  filter: ListFilter,
  key: SortKey,
  dir: SortDir,
  now = () => Date.now(),
): OrderedTorrents => {
  const order = useRef<string[]>([])
  const at = useRef(0)
  const view = useRef('')
  const interacting = useRef(false)

  const visible = visibleTorrents(all, filter)
  const byId = new Map(visible.map((t) => [t.id, t]))

  const viewKey = `${filter}:${key}:${dir}`
  const viewChanged = view.current !== viewKey
  // membership, not arrangement: an added or removed torrent makes the held order wrong rather than
  // merely stale, and a held order that omits a row would hide it entirely
  const idsChanged = order.current.length !== visible.length
    || order.current.some((id) => !byId.has(id))

  if (shouldReorder({
    viewChanged,
    idsChanged,
    volatile: isVolatile(key),
    interacting: interacting.current,
    sinceMs: now() - at.current,
  })) {
    order.current = sortTorrents(visible, key, dir).map((t) => t.id)
    at.current = now()
    view.current = viewKey
  }

  /*
   * Map the held ids back onto the CURRENT objects, so every number on every row is live even while
   * the arrangement is frozen. Anything the held order does not name is appended rather than
   * dropped: a row must never be invisible because the order is stale.
   */
  const rows: Torrent[] = []
  const placed = new Set<string>()
  for (const id of order.current) {
    const t = byId.get(id)
    if (t) { rows.push(t); placed.add(id) }
  }
  for (const t of visible) if (!placed.has(t.id)) rows.push(t)

  /**
   * `onPointerLeave` deliberately does NOT force a recompute. The next tick picks it up within about
   * half a second, by which time the pointer has gone and nothing moves under it. Forcing it here
   * would reshuffle the list at the exact moment somebody flicks the mouse away to read it.
   */
  const interaction = {
    onPointerEnter: useCallback(() => { interacting.current = true }, []),
    onPointerLeave: useCallback(() => { interacting.current = false }, []),
    onFocusCapture: useCallback(() => { interacting.current = true }, []),
    onBlurCapture: useCallback(() => { interacting.current = false }, []),
  }

  return { rows, interaction }
}
