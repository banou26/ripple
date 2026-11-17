import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import type { Persisted } from '../../src/torrent/library'

/**
 * The .torrent files follow the account whose backup the library sync read: a write uploads those of the list it
 * published, and an account change stops them at once, before the next account's backup has been read.
 */

const HASH = 'a'.repeat(40)
const entry = (infoHash: string): Persisted => ({ infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1_000 })

const cloudText = new Map<string, string>([['ripple/torrents.json', JSON.stringify([])]])
const listeners = new Set<(list: Persisted[]) => void>()
const checks: (() => boolean)[] = []
const synced: string[][] = []
let accountName = 'someone'
let accountChanged: (() => void) | undefined

vi.mock('@fkn/lib', () => ({
  account: {
    info: async () => ({ name: accountName }),
    onChange: async (cb: () => void) => { accountChanged = cb; return () => {} },
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
  resetThumbnailSync: () => {},
  syncThumbnails: async () => {},
}))

vi.mock('../../src/torrent/torrent-file-sync', () => ({
  followAccount: (check: (() => boolean) | null) => { if (check) checks.push(check) },
  forgetSyncedTorrentFiles: async () => {},
  syncTorrentFiles: async (hashes: string[]) => { synced.push(hashes) },
}))

const { useCloudBackup } = await import('../../src/torrent/use-cloud-backup')

const Harness = () => { useCloudBackup(); return null }

it('follows the account whose backup was read, uploads the published list\'s files, and stops at an account change', async () => {
  render(<Harness/>)
  await expect.poll(() => checks.length, { timeout: 15_000, message: 'the restore handed over no account to follow' }).toBe(1)
  const first = checks[0]!
  expect(first()).toBe(true)

  for (const listener of listeners) listener([entry(HASH)])
  await expect.poll(() => synced, { timeout: 15_000 }).toEqual([[HASH]])

  accountName = 'someone else'
  accountChanged?.()
  expect(first(), 'the files still followed the last account after it changed').toBe(false)
  // THE CONTROL: the next account's backup is read, and that account is followed in its turn
  await expect.poll(() => checks.length, { timeout: 15_000 }).toBe(2)
  expect(checks[1]!()).toBe(true)
  expect(first()).toBe(false)
}, 40_000)
