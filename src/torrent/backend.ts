import type { TorrentBackend } from './client'

export type { TorrentBackend }

const KEY = 'ripple:backend'

export const getBackend = (): TorrentBackend =>
  (typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'webtorrent') ? 'webtorrent' : 'libtorrent'

// Switching the engine means a different worker + storage layout, so the
// cleanest swap is to persist the choice and reload.
export const setBackend = (backend: TorrentBackend) => {
  localStorage.setItem(KEY, backend)
  location.reload()
}
