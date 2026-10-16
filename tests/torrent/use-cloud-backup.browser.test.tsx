import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import type { Persisted } from '../../src/torrent/library'

/**
 * The pictures a write syncs are those of the list it published, so neither a torrent
 * removed on another device that this one still runs, nor the unclaimed demo, uploads one.
 */

const HASH = 'a'.repeat(40)
const REMOVED = 'c'.repeat(40)
const entry = (infoHash: string, over: Partial<Persisted> = {}): Persisted =>
  ({ infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1_000, ...over })

const cloudText = new Map<string, string>([
  ['ripple/torrents.json', JSON.stringify([])],
  ['ripple/removed.json', JSON.stringify([{ infoHash: REMOVED, removedAt: 2_000 }])],
])
const synced: string[][] = []
const events: string[] = []
const listeners = new Set<(list: Persisted[]) => void>()

vi.mock('@fkn/lib', () => ({
  account: {
    info: async () => ({ name: 'someone' }),
    onChange: async () => () => {},
  },
  cloud: {
    fs: {
      available: async () => true,
      unlock: async () => false,
      promises: {
        readFile: async (path: string) => {
          const hit = cloudText.get(path)
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => { cloudText.set(path, data) },
      },
    },
  },
}))

const client = {
  onOwnership: (cb: (owned: boolean) => void) => { cb(true); return () => {} },
  onList: (cb: (list: Persisted[]) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  importList: () => {},
  clearList: () => {},
}
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

vi.mock('../../src/torrent/thumbnail-sync', () => ({
  forgetSyncedThumbnails: async () => {},
  resetThumbnailSync: () => { events.push('reset') },
  syncThumbnails: async (hashes: string[]) => { synced.push(hashes); events.push('sync') },
}))

const { useCloudBackup } = await import('../../src/torrent/use-cloud-backup')
const { DEMO_MAGNET } = await import('../../src/torrent/constants')
const { magnetInfoHash } = await import('../../src/torrent/magnet')

const Harness = () => {
  const { status } = useCloudBackup()
  return <div data-testid="status">{status}</div>
}

describe('the pictures a write syncs', () => {
  it('are those of the list it published', async () => {
    const demo = magnetInfoHash(DEMO_MAGNET)!
    render(<Harness/>)
    // the restore's own pass, over the account's list
    await expect.poll(() => synced.length, { timeout: 15_000 }).toBe(1)

    const local = [entry(HASH), entry(REMOVED, { started: true }), { ...entry(demo), magnet: DEMO_MAGNET, ephemeral: true }]
    for (const listener of listeners) listener(local)
    await expect.poll(() => synced.length, { timeout: 15_000 }).toBe(2)

    expect(JSON.parse(cloudText.get('ripple/torrents.json')!).map((e: Persisted) => e.infoHash)).toEqual([HASH])
    expect(synced[1]).toEqual([HASH])
  }, 40_000)

  /** the account's key is read again, or a new account's pictures are named with the last one's */
  it('start over after a restore that finds no backup yet', async () => {
    cloudText.delete('ripple/torrents.json')
    synced.length = 0; events.length = 0
    render(<Harness/>)
    await expect.poll(() => listeners.size, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => events.includes('reset'), { timeout: 15_000 }).toBe(true)
    for (const listener of listeners) listener([entry(HASH)])
    await expect.poll(() => synced.length, { timeout: 15_000 }).toBe(1)
    expect(events).toEqual(['reset', 'sync'])
  }, 40_000)

  /** an empty list deletes every picture under an old name, so a backup that is not a list must not read as one */
  it('are left alone by a restore whose backup is not a list', async () => {
    cloudText.set('ripple/torrents.json', JSON.stringify({ not: 'a list' }))
    synced.length = 0; events.length = 0
    const screen = await render(<Harness/>)
    await expect.element(screen.getByTestId('status'), { timeout: 15_000 }).toHaveTextContent('synced')
    expect(synced).toEqual([])
  }, 40_000)
})
