// The FKN quota is what the relay meters, so with the VPN off there is none to show and none is asked for.
import type { EngineTransport } from '../../src/torrent/vpn-config'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useQuota } from '../../src/torrent/use-quota'

/*
 * The engine's page half as the app's is: its transport latched, and handed to a new subscriber during the
 * subscribe call, which runs in an effect. So a hook's first render has no transport yet, as in the app.
 */
const page = vi.hoisted(() => ({ transport: 'relay' as string | null, asked: 0, listeners: new Set<(transport: string) => void>() }))
const client = vi.hoisted(() => ({
  onTransport: (cb: (transport: string) => void) => {
    page.listeners.add(cb)
    if (page.transport) cb(page.transport)
    return () => { page.listeners.delete(cb) }
  },
}))

vi.mock('@fkn/lib', () => ({ cloud: { quota: async () => { page.asked++; return { premium: false, throttled: false, remainingBytes: 4_000_000_000 } } } }))
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))

const engine = (transport: EngineTransport) => {
  page.transport = transport
  for (const cb of page.listeners) cb(transport)
}

// the browser tests share one storage, and another file can leave the VPN stored off
beforeEach(() => { localStorage.clear() })
afterEach(() => { page.transport = 'relay'; page.asked = 0; localStorage.clear() })

it('reads the quota while the engine is behind the relay, and before an engine has said', async () => {
  page.transport = null
  const { result } = await renderHook(() => useQuota(true))
  await expect.poll(() => result.current).toMatchObject({ remainingBytes: 4_000_000_000 })
})

it('has no quota to show with the VPN off, and asks for none, not even before the engine\'s word reaches it', async () => {
  localStorage.setItem('ripple:vpn', 'off')
  page.transport = 'direct'
  const { result } = await renderHook(() => useQuota(true))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(result.current).toBeNull()
  expect(page.asked).toBe(0)
})

it('drops the figure it had when the VPN is switched off, and reads it again when it is back on', async () => {
  const { result } = await renderHook(() => useQuota(true))
  await expect.poll(() => result.current).not.toBeNull()
  localStorage.setItem('ripple:vpn', 'off')
  engine('direct')
  await expect.poll(() => result.current).toBeNull()
  const asked = page.asked
  localStorage.removeItem('ripple:vpn')
  engine('relay')
  await expect.poll(() => result.current).not.toBeNull()
  await expect.poll(() => page.asked).toBe(asked + 1)
})
