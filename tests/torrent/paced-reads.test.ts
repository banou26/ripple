import type { StorageBackend } from 'libtorrent-wasm/types'

import { describe, expect, it } from 'vitest'

import { READ_SLICE_MS, pacedReads } from '../../src/torrent/paced-reads'

const storageOf = () => {
  const writes: unknown[][] = []
  const storage: StorageBackend = {
    onNewStorage: () => {},
    onRemoveStorage: () => {},
    read: (_id, fileIndex, _offset, len) => new Uint8Array(len).fill(fileIndex),
    write: (...args) => { writes.push(args) },
  }
  return { storage, writes }
}

/** Ends the stretch, as the engine's tick returning does. */
const tickEnds = () => Promise.resolve()

describe('pacedReads', () => {
  it('answers the reads of one stretch at once while it is shorter than the slice', () => {
    let clock = 1_000
    const paced = pacedReads(storageOf().storage, () => clock)
    const first = paced.read(0, 1, 0, 4)
    clock += READ_SLICE_MS - 1
    const last = paced.read(0, 2, 4, 4)
    expect(first).toEqual(new Uint8Array(4).fill(1))
    expect(last).toEqual(new Uint8Array(4).fill(2))
  })

  it('answers through a promise once the stretch has read for the whole slice, which ends the tick', async () => {
    let clock = 1_000
    const paced = pacedReads(storageOf().storage, () => clock)
    paced.read(0, 1, 0, 4)
    clock += READ_SLICE_MS
    const late = paced.read(0, 3, 0, 4)
    expect(late).toBeInstanceOf(Promise)
    expect(await late).toEqual(new Uint8Array(4).fill(3))
  })

  it('answers at once again in the next tick', async () => {
    let clock = 1_000
    const paced = pacedReads(storageOf().storage, () => clock)
    paced.read(0, 1, 0, 4)
    clock += READ_SLICE_MS
    expect(paced.read(0, 1, 0, 4)).toBeInstanceOf(Promise)
    await tickEnds()
    expect(paced.read(0, 4, 0, 4)).toEqual(new Uint8Array(4).fill(4))
  })

  it('keeps every other call as the storage has it', () => {
    const { storage, writes } = storageOf()
    const bytes = new Uint8Array(4)
    void pacedReads(storage).write(0, 1, 2, bytes)
    expect(writes).toEqual([[0, 1, 2, bytes]])
  })
})
