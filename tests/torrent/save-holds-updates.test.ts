import { describe, expect, it } from 'vitest'

import type { TorrentClient } from '../../src/torrent/client'
import { saveTorrentEntriesAsZipToDisk, saveTorrentFileToDisk } from '../../src/torrent/save-file'
import { pageWorkRunning } from '../../src/utils/page-work'

/** Ripple's update gate waits for page work, since a reload or a take-over cuts a save off half written. */
describe('a save to disk holds updates', () => {
  /** A client whose reads wait until released, then answer or fail as the test asks. */
  const heldClient = () => {
    let release = (_fail: boolean) => {}
    const held = new Promise<boolean>((resolve) => { release = resolve })
    const client = {
      read: async (_handle: number, _index: number, _offset: number, len: number) => {
        // AbortError is the person stopping the save, which ends it without a retry
        if (await held) throw new DOMException('stopped', 'AbortError')
        return new Uint8Array(len)
      },
    } as unknown as TorrentClient
    return { client, release }
  }

  it('from the start of a file save until it ends', async () => {
    const { client, release } = heldClient()
    const save = saveTorrentFileToDisk(client, 1, 0, 'a.bin', 4).catch(() => {})
    expect(await pageWorkRunning()).toBe(true)
    release(false)
    await save
    expect(await pageWorkRunning()).toBe(false)
  })

  it('for a zip save too, and lets go of one that fails', async () => {
    const { client, release } = heldClient()
    const save = saveTorrentEntriesAsZipToDisk(client, 1, 'pack', [{ index: 0, path: 'a.bin', size: 4 }])
    expect(await pageWorkRunning()).toBe(true)
    release(true)
    await expect(save).rejects.toThrow()
    expect(await pageWorkRunning()).toBe(false)
  })
})
