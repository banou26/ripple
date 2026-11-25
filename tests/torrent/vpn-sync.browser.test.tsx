import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { del } from 'idb-keyval'

import type { Reachability } from '../../src/torrent/client'

const cloudState = vi.hoisted(() => ({
  available: true,
  account: 'alice' as string | null,
  files: new Map<string, string>(),
  accountListeners: new Set<(change: { switched: boolean }) => void>(),
  unlockCalls: 0,
}))

vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))

vi.mock('@fkn/lib', () => ({
  account: {
    info: async () => (cloudState.account ? { name: cloudState.account, image: null, premium: false, premiumUntil: null } : null),
    onChange: async (cb: (change: { switched: boolean }) => void) => {
      cloudState.accountListeners.add(cb)
      return () => { cloudState.accountListeners.delete(cb) }
    },
  },
  cloud: {
    fs: {
      available: async () => cloudState.available,
      unlock: async () => { cloudState.unlockCalls += 1; return false },
      isNotFound: (err: unknown) => (err as { code?: string } | null)?.code === 'FKN_STORAGE_NOT_FOUND',
      promises: {
        readFile: async (path: string) => {
          const hit = cloudState.files.get(path)
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => { cloudState.files.set(path, data) },
      },
    },
  },
}))

const setVpn = vi.hoisted(() => vi.fn())
vi.mock('../../src/torrent/client', () => ({ setVpn }))

const { VpnSwitch } = await import('../../src/components/vpn-switch')
const { storeVpn } = await import('../../src/torrent/vpn-setting')
const { VPN_SYNC_KEY, VPN_SYNC_PATH, VpnCloudSync } = await import('../../src/torrent/vpn-sync')
const { IntlRoot } = await import('../../src/i18n')

const REACHABLE_ON: Reachability = {
  listening: { tcp: '0.0.0.0:41337' },
  listenFailed: [],
  inbound: 0,
  inboundByTransport: {},
  lastInbound: null,
  port: 41337,
  listeners: [{ transport: 'tcp', port: 41337, up: true, healing: false, attempts: 0 }],
  portOpen: true,
}

const vpnStorageKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('ripple:vpn')).sort()

const Harness = () => (
  <IntlRoot>
    <VpnCloudSync/>
    <VpnSwitch reachable={REACHABLE_ON} transport="relay" quota={null}/>
  </IntlRoot>
)

beforeEach(async () => {
  localStorage.removeItem('ripple:vpn')
  localStorage.removeItem('ripple:vpn-off-remembered')
  localStorage.removeItem('ripple:quota-offer')
  await del(VPN_SYNC_KEY).catch(() => {})
  cloudState.available = true
  cloudState.account = 'alice'
  cloudState.files.clear()
  cloudState.accountListeners.clear()
  cloudState.unlockCalls = 0
  setVpn.mockReset().mockImplementation(async (on: boolean) => { storeVpn(on) })
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem('ripple:vpn')
  localStorage.removeItem('ripple:vpn-off-remembered')
  localStorage.removeItem('ripple:quota-offer')
})

describe('VpnCloudSync with VpnSwitch', () => {
  it('pushes manual VPN switch toggles and updates VpnSwitch live on focus when another partition toggles VPN', async () => {
    let clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    expect(cloudState.files.has(VPN_SYNC_PATH)).toBe(false)

    // User clicks VpnSwitch to turn VPN off -> writes ripple/vpn.json without extra localStorage keys
    clock += 2_000
    await sw.click()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.element(sw).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      const saved = cloudState.files.get(VPN_SYNC_PATH)
      expect(saved).toBeTruthy()
      expect(JSON.parse(saved!)).toEqual({ on: false, updatedAt: clock })
    }, { timeout: 2_000 })
    expect(vpnStorageKeys()).toEqual(['ripple:vpn'])

    // Another partition (e.g. Stub embed) turns VPN back on and user switches focus back to this tab
    clock += 3_000
    cloudState.files.set(VPN_SYNC_PATH, JSON.stringify({ on: true, updatedAt: clock }))
    window.dispatchEvent(new Event('focus'))
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    expect(vpnStorageKeys()).toEqual([])

    // Another partition turns VPN off and tab becomes visible again
    clock += 3_000
    cloudState.files.set(VPN_SYNC_PATH, JSON.stringify({ on: false, updatedAt: clock }))
    document.dispatchEvent(new Event('visibilitychange'))
    await expect.element(sw).toHaveAttribute('aria-checked', 'false')
    expect(vpnStorageKeys()).toEqual(['ripple:vpn'])
    expect(cloudState.unlockCalls).toBe(0)
  })

  it('keeps local state untouched when signed out', async () => {
    cloudState.available = false
    cloudState.account = null
    cloudState.files.set(VPN_SYNC_PATH, JSON.stringify({ on: false, updatedAt: 9_999_999_999_999 }))

    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sw.element().getAttribute('aria-checked')).toBe('true')
    expect(vpnStorageKeys()).toEqual([])
  })
})
