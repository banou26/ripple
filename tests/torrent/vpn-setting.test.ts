// The stored choice of the VPN: On unless somebody switched it off in this storage, and On wherever Off cannot run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const listeners = new Set<(event: { key: string | null }) => void>()
const refuse = { storage: false }

beforeEach(() => {
  store.clear()
  listeners.clear()
  refuse.storage = false
  vi.resetModules()
  // whatever the constant is set to in the source: each case says which it is about
  vi.doMock('../../src/torrent/vpn-config', () => ({ WEBRTC_PEERS: true }))
  vi.stubGlobal('RTCPeerConnection', class {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => { if (refuse.storage) throw new Error('refused'); return store.get(key) ?? null },
    setItem: (key: string, value: string) => { if (refuse.storage) throw new Error('refused'); store.set(key, value) },
    removeItem: (key: string) => { if (refuse.storage) throw new Error('refused'); store.delete(key) },
  })
  vi.stubGlobal('window', {
    addEventListener: (_type: string, listener: (event: { key: string | null }) => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: (event: { key: string | null }) => void) => { listeners.delete(listener) },
  })
})

afterEach(() => { vi.unstubAllGlobals() })

const setting = () => import('../../src/torrent/vpn-setting')

describe('the stored choice', () => {
  it('is On until somebody switches it off, and On again once switched back', async () => {
    const { storeVpn, vpnOn } = await setting()
    expect(vpnOn()).toBe(true)
    expect(storeVpn(false)).toBe(true)
    expect(vpnOn()).toBe(false)
    expect([...store]).toEqual([['ripple:vpn', 'off']])
    expect(storeVpn(true)).toBe(true)
    expect(vpnOn()).toBe(true)
    expect(store.size, 'On is the absence of a choice, so nothing is kept for it').toBe(0)
  })

  it('reads as On while the feature is stopped, whatever was stored', async () => {
    store.set('ripple:vpn', 'off')
    vi.doMock('../../src/torrent/vpn-config', () => ({ WEBRTC_PEERS: false }))
    const { vpnOffAvailable, vpnOn } = await setting()
    expect(vpnOffAvailable()).toBe(false)
    expect(vpnOn()).toBe(true)
    expect(store.get('ripple:vpn'), 'the choice is kept for when the feature runs again').toBe('off')
  })

  it('reads as On in a browser with no WebRTC', async () => {
    store.set('ripple:vpn', 'off')
    vi.stubGlobal('RTCPeerConnection', undefined)
    const { vpnOffAvailable, vpnOn } = await setting()
    expect(vpnOffAvailable()).toBe(false)
    expect(vpnOn()).toBe(true)
  })

  it('reads as On, and says it kept nothing, where the browser refuses storage', async () => {
    refuse.storage = true
    const { storeVpn, vpnOn } = await setting()
    expect(vpnOn()).toBe(true)
    expect(storeVpn(false)).toBe(false)
  })

  it('tells of a change another page made to it, and of nothing else', async () => {
    const { onVpnStored } = await setting()
    const changed = vi.fn()
    const stop = onVpnStored(changed)
    const fire = (key: string | null) => { for (const listener of listeners) listener({ key }) }
    fire('ripple:demo-seeded')
    expect(changed).toHaveBeenCalledTimes(0)
    fire('ripple:vpn')
    fire(null)
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
    fire('ripple:vpn')
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
