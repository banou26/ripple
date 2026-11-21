import type { Persisted, TorrentSnapshot } from '../../src/torrent/client'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

const subscribed: Record<string, (value?: unknown) => void> = {}
const client = new Proxy({}, {
  get: (_, key) => typeof key === 'string' && key.startsWith('on')
    ? (cb: (value?: unknown) => void) => { subscribed[key] = cb; return () => { delete subscribed[key] } }
    : key === 'owns' ? () => false : () => Promise.resolve(),
})
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client, runningTorrentClient: () => null }))

const { useTorrents } = await import('../../src/torrent/use-torrents')
const { TorrentDetailDock } = await import('../../src/router/torrent-detail')
const { IntlRoot } = await import('../../src/i18n')

const HASH = 'aabbccddeeff00112233445566778899aabbccdd'
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Made%20here`
// as the library entry keeps it, in milliseconds
const LISTED = Date.UTC(2026, 10, 15, 14, 42, 30)

const entry: Persisted = { infoHash: HASH, magnet: MAGNET, savePath: '/dl', addedAt: LISTED, started: true, created: true }

// the engine's own add time, in seconds, which starts again whenever the torrent is added to a new session
const snapshot = (engineAddedAt: number) => ({
  handle: 1,
  magnet: MAGNET,
  files: null,
  status: {
    state: 5, paused: false, progress: 1, totalDone: 1000, totalWanted: 1000, totalWantedDone: 1000, downloadRate: 0, uploadRate: 0,
    numPeers: 0, numSeeds: 0, numPiecesTotal: 1, numPiecesHave: 1, flags: 0, queuePosition: -1, allTimeDownload: 0, allTimeUpload: 0,
    sessionDownload: 0, sessionUpload: 0, wasted: 0, swarmSeeds: -1, swarmPeers: -1, numConnections: 0, connectionsLimit: 0,
    availability: -1, activeSeconds: 0, seedingSeconds: 0, addedAt: engineAddedAt, completedAt: engineAddedAt, lastSeenComplete: 0,
    hadIncoming: false, savePath: '/dl',
  },
  bitfield: null,
  recovery: null,
  userPaused: false,
  displayDownloadRate: 0,
} as unknown as TorrentSnapshot)

const Panel = () => {
  const t = useTorrents().torrents[0]
  return t ? <TorrentDetailDock t={t} handle={Number(t.id) || null} saving={{}} onSave={() => {}} onClose={() => {}}/> : null
}

const fact = (container: HTMLElement, label: string) => [...container.querySelectorAll('.fact')]
  .find((f) => f.querySelector('label')?.textContent === label)?.querySelector('span')?.textContent?.replace(/\s/gu, ' ')

const written = (ms: number) => new Date(ms).toLocaleString('en-US').replace(/\s/gu, ' ')

// measured on a created torrent: "Added on" went from 11:42:30 PM to 11:43:22 PM across one reload
it('keeps the date a torrent was added across a reload, where the engine starts its own clock again', async () => {
  const screen = await render(<Panel/>, { wrapper: IntlRoot })
  await expect.poll(() => subscribed.onList && subscribed.onState && subscribed.onEngineReset).toBeTruthy()
  subscribed.onList!([entry])
  subscribed.onState!([snapshot(LISTED / 1000 + 2)])
  await expect.poll(() => fact(screen.container, 'Completed on')).toBe(written(LISTED + 2000))
  expect(fact(screen.container, 'Added on')).toBe(written(LISTED))

  subscribed.onEngineReset!()
  subscribed.onState!([snapshot(LISTED / 1000 + 52)])
  await expect.poll(() => fact(screen.container, 'Completed on')).toBe(written(LISTED + 52_000))
  expect(fact(screen.container, 'Added on')).toBe(written(LISTED))
})
