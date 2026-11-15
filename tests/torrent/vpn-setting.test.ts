// The stored choice of the VPN: On unless somebody switched it off in this storage, and On wherever Off cannot run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const listeners = new Set<(event: { key: string | null }) => void>()
const refuse = { storage: false }
// One mock whose value a case sets: vitest resolves two queued doMock calls of one path in parallel, and the
// one resolved last wins, so a second doMock in a case lost to the first now and then under load.
const config = { WEBRTC_PEERS: true }

beforeEach(() => {
  store.clear()
  listeners.clear()
  refuse.storage = false
  config.WEBRTC_PEERS = true
  vi.resetModules()
  // whatever the constant is set to in the source: each case says which it is about
  vi.doMock('../../src/torrent/vpn-config', () => ({ WEBRTC_PEERS: config.WEBRTC_PEERS }))
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
    config.WEBRTC_PEERS = false
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

describe('Remember this decision', () => {
  it('is not set until somebody ticks it, and is kept beside the choice, not in it', async () => {
    const { rememberVpnWarning, storeVpn, vpnOn, vpnWarningRemembered } = await setting()
    expect(vpnWarningRemembered()).toBe(false)
    rememberVpnWarning()
    expect(vpnWarningRemembered()).toBe(true)
    expect([...store]).toEqual([['ripple:vpn-off-remembered', '1']])
    // remembering the warning switches nothing, and the choice changing forgets nothing
    expect(vpnOn()).toBe(true)
    storeVpn(false)
    storeVpn(true)
    expect(vpnWarningRemembered()).toBe(true)
  })

  it('asks again where the browser refuses storage, rather than throwing', async () => {
    refuse.storage = true
    const { rememberVpnWarning, vpnWarningRemembered } = await setting()
    expect(() => rememberVpnWarning()).not.toThrow()
    expect(vpnWarningRemembered()).toBe(false)
  })
})

// The relay counts the FKN quota per UTC day, so an answer to the offer made once it is used up holds until the next.
describe('the quota offer', () => {
  const at = (iso: string) => Date.parse(iso)
  const tz = process.env.TZ
  afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz })

  it('is unanswered until answered, then answered for the rest of the UTC day and no longer', async () => {
    // eight hours behind UTC, so both moments below are the 16th there: a day read in local time holds the answer over
    process.env.TZ = 'America/Los_Angeles'
    expect(new Date(at('2026-11-17T00:01:00Z')).getDate()).toBe(16)
    const { answerQuotaOffer, quotaOfferAnswered } = await setting()
    expect(quotaOfferAnswered(at('2026-11-16T23:59:00Z'))).toBe(false)
    answerQuotaOffer(at('2026-11-16T23:59:00Z'))
    expect(quotaOfferAnswered(at('2026-11-16T23:59:00Z'))).toBe(true)
    expect(quotaOfferAnswered(at('2026-11-16T00:00:00Z'))).toBe(true)
    expect(quotaOfferAnswered(at('2026-11-17T00:01:00Z'))).toBe(false)
    expect(quotaOfferAnswered(at('2026-11-15T23:59:00Z'))).toBe(false)
  })

  it('keeps the day alone, the same for everyone that day, beside the choice and not in it', async () => {
    const { answerQuotaOffer, quotaDay, vpnOn } = await setting()
    answerQuotaOffer(at('2026-11-16T12:00:00Z'))
    expect([...store]).toEqual([['ripple:quota-offer', String(quotaDay(at('2026-11-16T12:00:00Z')))]])
    expect(store.get('ripple:quota-offer')).toMatch(/^\d+$/)
    expect(quotaDay(at('2026-11-16T00:00:00Z'))).toBe(20_773)
    expect(vpnOn()).toBe(true)
  })

  it('reads as unanswered where the browser refuses storage, and answering it throws nothing', async () => {
    refuse.storage = true
    const { answerQuotaOffer, quotaOfferAnswered } = await setting()
    expect(() => answerQuotaOffer()).not.toThrow()
    expect(quotaOfferAnswered()).toBe(false)
  })
})
