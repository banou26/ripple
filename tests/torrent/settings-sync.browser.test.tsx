import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { del, get, set } from 'idb-keyval'

import type { Reachability } from '../../src/torrent/client'

const cloudState = vi.hoisted(() => ({
  available: true,
  account: 'alice' as string | null,
  files: new Map<string, string>(),
  reads: [] as string[],
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
          cloudState.reads.push(path)
          const hit = cloudState.files.get(path)
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => { cloudState.files.set(path, data) },
      },
    },
  },
}))

const clientMocks = vi.hoisted(() => ({
  setVpn: vi.fn(),
  setSeedingPolicy: vi.fn(),
  setSessionLimits: vi.fn(),
  latestRateLimits: vi.fn(() => ({ down: 0, up: 0 })),
}))

vi.mock('../../src/torrent/client', () => ({
  setVpn: clientMocks.setVpn,
  runningTorrentClient: () => ({
    setSeedingPolicy: clientMocks.setSeedingPolicy,
    setSessionLimits: clientMocks.setSessionLimits,
    latestRateLimits: clientMocks.latestRateLimits,
  }),
}))

const { VpnSwitch } = await import('../../src/components/vpn-switch')
const { LanguageSelect } = await import('../../src/components/language-select')
const { storeVpn } = await import('../../src/torrent/vpn-setting')
const { IntlRoot, startLanguage } = await import('../../src/i18n')
const { keepPlayerVolume, PLAYER_VOLUME_KEY } = await import('../../src/router/player-volume')
const { accountTag } = await import('../../src/torrent/groups')
const { RATE_LIMITS_KEY } = await import('../../src/torrent/rate-limits')
const { SEEDING_POLICY_KEY } = await import('../../src/torrent/seeding-policy')
const {
  LEGACY_VPN_SYNC_KEY, LEGACY_VPN_SYNC_PATH, SETTINGS_SYNC_KEY, SETTINGS_SYNC_PATH, syncSettings,
} = await import('../../src/torrent/settings-sync')
const { SettingsCloudSync } = await import('../../src/components/settings-cloud-sync')

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

const clearAllSettings = () => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('ripple:')) localStorage.removeItem(key)
  }
}

const Harness = () => (
  <IntlRoot>
    <SettingsCloudSync/>
    <VpnSwitch reachable={REACHABLE_ON} transport="relay" quota={null}/>
    <LanguageSelect/>
  </IntlRoot>
)

beforeEach(async () => {
  clearAllSettings()
  await del(SETTINGS_SYNC_KEY).catch(() => {})
  await del(LEGACY_VPN_SYNC_KEY).catch(() => {})
  await del(RATE_LIMITS_KEY).catch(() => {})
  await del(SEEDING_POLICY_KEY).catch(() => {})
  cloudState.available = true
  cloudState.account = 'alice'
  cloudState.files.clear()
  cloudState.reads.length = 0
  cloudState.accountListeners.clear()
  cloudState.unlockCalls = 0
  clientMocks.setVpn.mockReset().mockImplementation(async (on: boolean) => { storeVpn(on) })
  clientMocks.setSeedingPolicy.mockReset()
  clientMocks.setSessionLimits.mockReset()
  await startLanguage({ language: 'en' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearAllSettings()
  await startLanguage({ language: 'en' })
})

describe('SettingsCloudSync', () => {
  it('syncs VPN, language, seeding policy, rate limits, and player volume across partitions without extra ripple:vpn keys', async () => {
    let clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    expect(cloudState.files.has(SETTINGS_SYNC_PATH)).toBe(false)

    // User toggles VPN off -> writes ripple/settings.json cleanly
    clock += 2_000
    await sw.click()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.element(sw).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() => {
      const saved = cloudState.files.get(SETTINGS_SYNC_PATH)
      expect(saved).toBeTruthy()
      expect(JSON.parse(saved!).vpn).toEqual({ value: false, updatedAt: clock })
    }, { timeout: 2_000 })
    expect(vpnStorageKeys()).toEqual(['ripple:vpn'])

    // User changes language in LanguageSelect -> persisted to ripple/settings.json
    clock += 2_000
    const langSelect = screen.getByRole('combobox')
    await langSelect.selectOptions('de')
    await vi.waitFor(() => {
      const saved = JSON.parse(cloudState.files.get(SETTINGS_SYNC_PATH)!)
      expect(saved.language).toEqual({ value: 'de', updatedAt: clock })
    }, { timeout: 2_000 })

    // Remote partition updates VPN, seedingPolicy, rateLimits, and playerVolume
    const video = document.createElement('video')
    const stopVolume = keepPlayerVolume(video)
    try {
      clock += 3_000
      cloudState.files.set(SETTINGS_SYNC_PATH, JSON.stringify({
        vpn: { value: true, updatedAt: clock },
        language: { value: 'de', updatedAt: clock - 3_000 },
        seedingPolicy: { value: { ratio: 1.5, minutes: 30 }, updatedAt: clock },
        rateLimits: { value: { down: 2_000_000, up: 500_000 }, updatedAt: clock },
        playerVolume: { value: { volume: 0.4, muted: true }, updatedAt: clock },
      }))
      window.dispatchEvent(new Event('focus'))

      await expect.element(sw).toHaveAttribute('aria-checked', 'true')
      expect(vpnStorageKeys()).toEqual([])
      expect(JSON.parse(localStorage.getItem('ripple:seeding-policy')!)).toEqual({ ratio: 1.5, minutes: 30 })
      expect(clientMocks.setSeedingPolicy).toHaveBeenCalledWith({ ratio: 1.5, minutes: 30 })
      expect(clientMocks.setSessionLimits).toHaveBeenCalledWith({ down: 2_000_000, up: 500_000 })
      await vi.waitFor(() => {
        expect(video.volume).toBeCloseTo(0.4)
        expect(video.muted).toBe(true)
        expect(JSON.parse(localStorage.getItem(PLAYER_VOLUME_KEY)!)).toEqual({ volume: 0.4, muted: true })
      }, { timeout: 2_000 })
      expect(cloudState.unlockCalls).toBe(0)
    } finally {
      stopVolume()
    }
  })

  it('migrates legacy ripple/vpn.json into ripple/settings.json and prompts before turning local VPN off', async () => {
    cloudState.files.set(LEGACY_VPN_SYNC_PATH, JSON.stringify({ on: false, updatedAt: 123_456 }))
    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await vi.waitFor(() => {
      const migrated = cloudState.files.get(SETTINGS_SYNC_PATH)
      expect(migrated).toBeTruthy()
      expect(JSON.parse(migrated!).vpn).toEqual({ value: false, updatedAt: 123_456 })
    }, { timeout: 2_000 })
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    await expect.element(screen.getByText('Your synced settings have the VPN turned off.')).toBeInTheDocument()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.element(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps local state untouched when signed out', async () => {
    cloudState.available = false
    cloudState.account = null
    cloudState.files.set(SETTINGS_SYNC_PATH, JSON.stringify({
      vpn: { value: false, updatedAt: 9_999_999_999_999 },
      language: { value: 'ja', updatedAt: 9_999_999_999_999 },
    }))

    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sw.element().getAttribute('aria-checked')).toBe('true')
    expect(vpnStorageKeys()).toEqual([])
    expect(localStorage.getItem('ripple:language')).toBeNull()
  })

  it('migrates legacy IDB ripple:vpn-sync once into ripple:settings-sync and settles on synced', async () => {
    const tag = await accountTag('alice')
    storeVpn(false)
    await set(LEGACY_VPN_SYNC_KEY, { account: tag, on: false, updatedAt: 456_789 })

    const outcome = await syncSettings()
    expect(outcome).toBe('synced')

    const migrated = await get<{ account: string | null, entries: { vpn?: { value: boolean, updatedAt: number } }, legacyVpnChecked?: boolean }>(SETTINGS_SYNC_KEY)
    expect(migrated).toEqual({
      account: tag,
      entries: { vpn: { value: false, updatedAt: 456_789 } },
      legacyVpnChecked: true,
    })
    const uploaded = JSON.parse(cloudState.files.get(SETTINGS_SYNC_PATH)!)
    expect(uploaded.vpn).toEqual({ value: false, updatedAt: 456_789 })
  })

  it('asks confirmation before applying remote vpn=false and stops re-reading absent legacy vpn.json', async () => {
    await syncSettings()
    await syncSettings()
    expect(cloudState.reads.filter((p) => p === LEGACY_VPN_SYNC_PATH)).toHaveLength(1)

    cloudState.files.set(SETTINGS_SYNC_PATH, JSON.stringify({
      vpn: { value: false, updatedAt: 2_000_000_000_000 },
    }))
    const screen = await render(<Harness/>)
    const sw = screen.getByRole('switch')
    await expect.element(screen.getByText('Your synced settings have the VPN turned off.')).toBeInTheDocument()
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')

    await screen.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(sw).toHaveAttribute('aria-checked', 'true')
    // Re-syncing the same declined timestamp does not re-open the prompt
    await syncSettings()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    // A newer remote vpn=false timestamp prompts again, and confirming turns local VPN off
    cloudState.files.set(SETTINGS_SYNC_PATH, JSON.stringify({
      vpn: { value: false, updatedAt: 2_000_000_005_000 },
    }))
    await syncSettings()
    await expect.element(screen.getByText('Your synced settings have the VPN turned off.')).toBeInTheDocument()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.element(sw).toHaveAttribute('aria-checked', 'false')
  })
})
