import { describe, expect, it } from 'vitest'

import type { TorrentClient } from '../../src/torrent/client'
import { saveTorrentEntriesAsZipToDisk, saveTorrentFileToDisk, savesRunning } from '../../src/torrent/save-file'

/** Ripple's update gate reloads only at zero, since a reload cuts a save to disk off half written. */
describe('saves running', () => {
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

  it('counts a file save from its start until it ends', async () => {
    const { client, release } = heldClient()
    const save = saveTorrentFileToDisk(client, 1, 0, 'a.bin', 4).catch(() => {})
    expect(savesRunning()).toBe(1)
    release(false)
    await save
    expect(savesRunning()).toBe(0)
  })

  it('counts a zip save, and lets go of one that fails', async () => {
    const { client, release } = heldClient()
    const save = saveTorrentEntriesAsZipToDisk(client, 1, 'pack', [{ index: 0, path: 'a.bin', size: 4 }])
    expect(savesRunning()).toBe(1)
    release(true)
    await expect(save).rejects.toThrow()
    expect(savesRunning()).toBe(0)
  })
})
