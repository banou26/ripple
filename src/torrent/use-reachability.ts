import { useEffect, useState } from 'react'

import type { Reachability } from './client'
import { getTorrentClient } from './client'

/**
 * The engine's current reachability, for pages that want it and nothing else.
 *
 * `useTorrents` already carries this, but it also carries the library, the persisted list, the demo
 * seeding and a storage watcher, none of which belong on a download page or behind a player. This is
 * the one subscription on its own.
 *
 * `onReachable` is latched, so a page that mounts long after the engine settled still gets the
 * current value rather than waiting for the next change.
 */
export const useReachability = (): Reachability | null => {
  const client = getTorrentClient()
  const [reachable, setReachable] = useState<Reachability | null>(null)
  useEffect(() => client.onReachable(setReachable), [client])
  return reachable
}
