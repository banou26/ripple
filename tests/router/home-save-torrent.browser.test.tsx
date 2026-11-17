import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'

/** Save .torrent on a row synced from another device goes through the account's copy of its file. */

const HASH = 'a'.repeat(40)
const SYNCED: Persisted = {
  infoHash: HASH, magnet: 'magnet:?xt=urn:btih:' + HASH, savePath: '/dl/' + HASH, addedAt: 1_000, started: false,
  name: 'From.Elsewhere', size: 11, files: [{ name: 'From.Elsewhere/x.bin', size: 11 }],
}

const client = new Proxy({}, {
  get: (_, key) => {
    if (key === 'onList') return (cb: (list: Persisted[]) => void) => { cb([SYNCED]); return () => {} }
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {}
    return key === 'owns' ? () => false : () => Promise.resolve()
  },
})
vi.mock('../../src/torrent/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/client')>()),
  getTorrentClient: () => client,
}))

const asked: string[] = []
vi.mock('../../src/torrent/torrent-file-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/torrent-file-sync')>()),
  saveSyncedTorrentFile: async ({ infoHash }: { infoHash: string }) => { asked.push(infoHash); return 'saved' },
}))

const { default: Home } = await import('../../src/router/home')

it('saves a synced row\'s .torrent through the account\'s copy', async () => {
  const screen = await render(<IntlRoot><MemoryRouter><Home/></MemoryRouter></IntlRoot>)
  // the DOM's own clicks: a locator's click on the row's Options button timed out in this harness (2026-11-17)
  await expect.element(screen.getByRole('button', { name: 'Options for From.Elsewhere' })).toBeVisible()
  ;(screen.getByRole('button', { name: 'Options for From.Elsewhere' }).element() as HTMLElement).click()
  await expect.element(screen.getByRole('button', { name: 'Save .torrent' })).toBeVisible()
  ;(screen.getByRole('button', { name: 'Save .torrent' }).element() as HTMLElement).click()
  await expect.poll(() => asked).toEqual([HASH])
})
