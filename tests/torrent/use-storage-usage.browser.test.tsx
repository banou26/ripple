// The room downloads the person keeps leave for a temporary film is not theirs to fill, so every figure drawn from this
// reading (the Storage readout, "Running out of room", the add dialog's room) counts it as used (RIPPLE-185).
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { RESERVE_BYTES } from '../../src/torrent/storage-budget'
import { useStorageUsage } from '../../src/torrent/use-storage-usage'

const GiB = 1024 ** 3
const reading = vi.hoisted(() => ({ usage: 0, quota: 0 }))

vi.mock('@banou/ponyfill', () => ({
  storage: { estimate: async () => ({ ...reading }), persisted: async () => false },
}))

afterEach(() => { reading.usage = 0; reading.quota = 0 })

const read = async (usage: number, quota: number) => {
  Object.assign(reading, { usage, quota })
  const { result } = await renderHook(() => useStorageUsage(0))
  await expect.poll(() => result.current).not.toBeNull()
  return result.current!
}

it('counts the room kept for temporary films as used, never as left', async () => {
  const { usedBytes, limitBytes } = await read(2 * GiB, 10 * GiB)
  expect(usedBytes).toBe(2 * GiB + RESERVE_BYTES)
  expect(limitBytes).toBe(10 * GiB)
})

it('stops at the limit, so the room left reads nothing rather than less', async () => {
  expect((await read(9 * GiB, 10 * GiB)).usedBytes).toBe(10 * GiB)
})

it('leaves a measurement already past the limit as it is', async () => {
  expect((await read(10.5 * GiB, 10 * GiB)).usedBytes).toBe(10.5 * GiB)
})
