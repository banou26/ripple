import type { UseTorrents } from '../../src/torrent/use-torrents'

import { useEffect } from 'react'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { clear, get } from 'idb-keyval'

import { IntlRoot } from '../../src/i18n'

/**
 * Download on a row synced from another device: the account holds its .torrent and this device has nothing. The
 * engine is told to start only once the file is kept here, so it adds the torrent with its file list instead of
 * waiting for a peer to send one. A row the account holds no file of starts as before.
 */

const KEY = new Uint8Array(32).fill(3)
const TORRENT = new TextEncoder().encode('d4:infod6:lengthi1e4:name1:x12:piece lengthi16384e6:pieces20:ppppppppppppppppppppee')
const SYNCED = 'a'.repeat(40)
const NOT_SYNCED = 'b'.repeat(40)

const cloudFiles = new Map<string, Uint8Array>()
const reads: string[] = []

vi.mock('@fkn/lib', () => ({
  account: { info: async () => null, onChange: async () => () => {} },
  cloud: {
    fs: {
      available: async () => false,
      isNotFound: (err: unknown) => (err as { code?: string })?.code === 'FKN_STORAGE_NOT_FOUND',
      promises: {
        readFile: async (path: string) => {
          reads.push(path)
          // slow, as the broker is, so a start sent before the file is kept would be seen
          await new Promise((resolve) => setTimeout(resolve, 200))
          const hit = cloudFiles.get(path)
          if (!hit) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async () => {},
        readdir: async () => [],
        unlink: async () => {},
      },
    },
  },
}))

/** What the engine would find kept for each torrent at the moment it was told to start it. */
const started: Promise<{ infoHash: string, kept: Uint8Array | undefined }>[] = []
const keptNow = (infoHash: string) => get<Uint8Array>('ripple:torrent:' + infoHash).then((kept) => ({ infoHash, kept }))
/** The same for each command that started many at once. */
const startedMany: Promise<{ infoHash: string, kept: Uint8Array | undefined }[]>[] = []
const client = new Proxy({}, {
  get: (_, key) => {
    if (key === 'start') return (infoHash: string) => { started.push(keptNow(infoHash)) }
    if (key === 'startMany') return (infoHashes: string[]) => { startedMany.push(Promise.all(infoHashes.map(keptNow))) }
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {}
    return key === 'owns' ? () => false : () => Promise.resolve()
  },
})
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

const { NAME_KEY_PATH } = await import('../../src/torrent/thumbnail-sync')
const { followAccount, torrentFilePath } = await import('../../src/torrent/torrent-file-sync')
const { useTorrents } = await import('../../src/torrent/use-torrents')

const pathOf = async (infoHash: string) => {
  const key = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('torrent:' + infoHash)))
  return torrentFilePath([...mac].map((b) => b.toString(16).padStart(2, '0')).join(''))
}
const fileReads = () => reads.filter((path) => path !== NAME_KEY_PATH)

let hook: UseTorrents | undefined
const Probe = () => {
  const value = useTorrents()
  useEffect(() => { hook = value })
  return null
}

it('starts a row synced from another device with the account\'s .torrent kept, and one it holds none of as before', async () => {
  await clear()
  cloudFiles.set(NAME_KEY_PATH, KEY)
  cloudFiles.set(await pathOf(SYNCED), TORRENT)
  followAccount(() => true)
  try {
    await render(<IntlRoot><Probe/></IntlRoot>)
    await expect.poll(() => hook !== undefined).toBe(true)

    hook!.start(SYNCED)
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(1)
    const first = await started[0]!
    expect(first.infoHash).toBe(SYNCED)
    expect(first.kept, 'the engine was told to start before the account\'s .torrent was kept').toEqual(TORRENT)
    expect(fileReads()).toEqual([await pathOf(SYNCED)])

    // kept now, so a second Download asks the account nothing
    hook!.start(SYNCED)
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(2)
    expect(fileReads()).toHaveLength(1)

    // THE CONTROL: a row the account holds no file of still starts, from its magnet
    hook!.start(NOT_SYNCED)
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(3)
    expect((await started[2]!).kept).toBeUndefined()
  } finally {
    followAccount(null)
  }
})

it('starts many rows in one command once the account\'s .torrent of each is kept, and rows it holds none of as before', async () => {
  // a synced row at each end, so a keep that skips the first or the last row is seen
  const [first, notSynced, last] = ['c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)]
  await clear()
  cloudFiles.set(NAME_KEY_PATH, KEY)
  cloudFiles.set(await pathOf(first), TORRENT)
  cloudFiles.set(await pathOf(last), TORRENT)
  followAccount(() => true)
  try {
    await render(<IntlRoot><Probe/></IntlRoot>)
    await expect.poll(() => hook !== undefined).toBe(true)

    hook!.startMany([first, notSynced, last])
    await expect.poll(() => startedMany.length, { timeout: 5_000 }).toBe(1)
    expect(await startedMany[0]!).toEqual([
      { infoHash: first, kept: TORRENT },
      { infoHash: notSynced, kept: undefined },
      { infoHash: last, kept: TORRENT },
    ])
    expect(started).toHaveLength(3)
  } finally {
    followAccount(null)
  }
})
