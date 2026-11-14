// The FKN quota is what the relay meters, so with the VPN off there is none to show and none is asked for.
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useQuota } from '../../src/torrent/use-quota'

const page = vi.hoisted(() => ({ transport: 'relay' as string | null, asked: 0 }))

vi.mock('@fkn/lib', () => ({ cloud: { quota: async () => { page.asked++; return { premium: false, throttled: false, remainingBytes: 4_000_000_000 } } } }))
vi.mock('../../src/torrent/use-reachability', () => ({ useEngineTransport: () => page.transport }))

afterEach(() => { page.transport = 'relay'; page.asked = 0 })

it('reads the quota while the engine is behind the relay, and before an engine has said', async () => {
  page.transport = null
  const { result } = await renderHook(() => useQuota(true))
  await expect.poll(() => result.current).toMatchObject({ remainingBytes: 4_000_000_000 })
})

it('has no quota to show with the VPN off, and asks for none', async () => {
  page.transport = 'direct'
  const { result } = await renderHook(() => useQuota(true))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(result.current).toBeNull()
  expect(page.asked).toBe(0)
})

it('drops the figure it had when the VPN is switched off, and reads it again when it is back on', async () => {
  const { result, rerender } = await renderHook(() => useQuota(true))
  await expect.poll(() => result.current).not.toBeNull()
  page.transport = 'direct'
  await rerender()
  await expect.poll(() => result.current).toBeNull()
  const asked = page.asked
  page.transport = 'relay'
  await rerender()
  await expect.poll(() => result.current).not.toBeNull()
  expect(page.asked).toBe(asked + 1)
})
