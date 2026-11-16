import { expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useGroups } from '../../src/torrent/groups'

vi.mock('idb-keyval', async (original) => ({
  ...(await original<typeof import('idb-keyval')>()),
  get: () => Promise.reject(new Error('blocked')),
}))

it('shows no groups, rather than loading for good, when this browser refuses the read', async () => {
  const { result } = await renderHook(() => useGroups())
  await expect.poll(() => result.current).toEqual([])
})
