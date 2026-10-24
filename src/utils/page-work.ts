import { hasWebLocks } from '../torrent/engine-protocol'

const LOCK = 'ripple:page-work'

let running = 0

/**
 * Runs work that lives in this page and that an update would throw away: a save to disk, creating a
 * torrent, moving files. While any of it runs, in this page or any other Ripple page of the origin,
 * the update gate neither reloads nor takes a new worker over (see use-ripple-update.ts).
 *
 * `work` runs synchronously up to its first await, so a picker or sink it opens there keeps the
 * click's activation. Other pages see it through a shared Web Lock, which the browser also lets go
 * of when the page goes away.
 */
export const pageWork = async <T>(work: () => Promise<T>): Promise<T> => {
  running++
  let settle = () => {}
  const settled = new Promise<void>((resolve) => { settle = resolve })
  if (hasWebLocks()) void navigator.locks.request(LOCK, { mode: 'shared' }, () => settled).catch(() => {})
  try {
    return await work()
  } finally {
    running--
    settle()
  }
}

/** Whether page work runs in this page or in another Ripple page of this origin. */
export const pageWorkRunning = async (): Promise<boolean> => {
  if (running > 0) return true
  if (!hasWebLocks()) return false
  const { held = [] } = await navigator.locks.query().catch(() => ({ held: [] }))
  return held.some((lock) => lock.name === LOCK)
}
