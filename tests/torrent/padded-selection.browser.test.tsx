import type { Persisted } from '../../src/torrent/client'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { CHOSEN, E02_PIECES, paddedPack } from './padded-pack'

const subscribed: Record<string, (value: unknown) => void> = {}
const client = new Proxy({}, {
  get: (_, key) => typeof key === 'string' && key.startsWith('on')
    ? (cb: (value: unknown) => void) => { subscribed[key] = cb; return () => { delete subscribed[key] } }
    : key === 'owns' ? () => false : () => Promise.resolve(),
})
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

const { useTorrents } = await import('../../src/torrent/use-torrents')
const { IntlRoot } = await import('../../src/i18n')

const Progress = () => <output>{String(useTorrents().torrents[0]?.progress)}</output>

it('reads a row by the files its library entry chose, so a finished padded selection is 100%', async () => {
  const screen = await render(<IntlRoot><Progress/></IntlRoot>)
  await expect.poll(() => subscribed.onList && subscribed.onState).toBeTruthy()
  const pack = paddedPack({ state: 4, progress: 301_000 / 344_064, totalDone: 301_000, totalWanted: 344_064, totalWantedDone: 301_000 }, E02_PIECES)
  const entry: Persisted = { infoHash: 'aabbccddeeff00112233445566778899aabbccdd', magnet: pack.magnet, savePath: '/dl', addedAt: 1, started: true, wantedFiles: CHOSEN }
  subscribed.onList!([entry])
  subscribed.onState!([pack])
  await expect.poll(() => screen.container.textContent).not.toBe('undefined')
  expect(screen.container.textContent).toBe('1')
})
