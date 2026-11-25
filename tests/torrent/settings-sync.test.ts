import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  createSettingsSyncController,
  parseLegacyVpnSync,
  parseSettingsSync,
  resolveSettingsSync,
  type CloudReadResult,
  type SettingsValues,
  type StoredSettingsSync,
  type SyncedEntry,
} from '../../src/torrent/settings-sync'

const ACCT_A = 'a'.repeat(64)
const ACCT_B = 'b'.repeat(64)

const baseLocal = (overrides: Partial<SettingsValues> = {}): SettingsValues => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
})

describe('parseSettingsSync & parseLegacyVpnSync', () => {
  it('parses valid known entries, drops malformed fields cleanly, and preserves unknown entries', () => {
    expect(parseSettingsSync(null)).toBeNull()
    expect(parseSettingsSync([])).toBeNull()
    expect(parseSettingsSync({})).toEqual({ entries: {}, extra: {} })

    const parsed = parseSettingsSync({
      vpn: { value: false, updatedAt: 100 },
      language: { value: 'ja', updatedAt: 200 },
      seedingPolicy: { value: { ratio: 1.5, minutes: 30 }, updatedAt: 300 },
      rateLimits: { value: { down: 500_000, up: -1 }, updatedAt: 400 },
      playerVolume: { value: { volume: 1.5, muted: false }, updatedAt: 500 },
      listView: { value: 'table', updatedAt: -1 },
      dockHeight: { value: 420, updatedAt: 600 },
      futureSetting: { value: { enabled: true }, updatedAt: 700 },
    })

    expect(parsed).toEqual({
      entries: {
        vpn: { value: false, updatedAt: 100 },
        language: { value: 'ja', updatedAt: 200 },
        seedingPolicy: { value: { ratio: 1.5, minutes: 30 }, updatedAt: 300 },
        dockHeight: { value: 420, updatedAt: 600 },
      },
      extra: {
        futureSetting: { value: { enabled: true }, updatedAt: 700 },
      },
    })
  })

  it('parses legacy ripple/vpn.json payloads strictly', () => {
    expect(parseLegacyVpnSync({ on: false, updatedAt: 500 })).toEqual({ on: false, updatedAt: 500 })
    expect(parseLegacyVpnSync({ on: 'false', updatedAt: 500 })).toBeNull()
    expect(parseLegacyVpnSync({ on: true, updatedAt: -1 })).toBeNull()
  })
})

describe('resolveSettingsSync', () => {
  it('avoids noisy cloud writes for untouched default state', () => {
    const res = resolveSettingsSync({
      account: ACCT_A,
      local: baseLocal(),
      stored: undefined,
      remote: null,
      now: 500,
    })
    expect(res.apply).toEqual({})
    expect(res.writeCloud).toBe(false)
    expect(res.cloudPayload).toEqual({})
  })

  it('merges concurrent changes across independent keys without clobbering either side', () => {
    const res = resolveSettingsSync({
      account: ACCT_A,
      local: baseLocal({ vpn: false, language: 'es-419', addDialog: true }),
      stored: {
        account: ACCT_A,
        entries: {
          vpn: { value: false, updatedAt: 2_000 },
          addDialog: { value: true, updatedAt: 2_500 },
        },
      },
      remote: {
        vpn: { value: true, updatedAt: 1_000 },
        language: { value: 'ja', updatedAt: 3_000 },
        seedingPolicy: { value: { ratio: 1.5, minutes: null }, updatedAt: 3_500 },
      },
      extra: { futureKey: { value: 'keep-me', updatedAt: 99 } },
    })

    expect(res.writeCloud).toBe(true)
    expect(res.apply).toEqual({
      language: 'ja',
      seedingPolicy: { ratio: 1.5, minutes: null },
    })
    expect(res.cloudPayload).toEqual({
      vpn: { value: false, updatedAt: 2_000 },
      language: { value: 'ja', updatedAt: 3_000 },
      addDialog: { value: true, updatedAt: 2_500 },
      seedingPolicy: { value: { ratio: 1.5, minutes: null }, updatedAt: 3_500 },
      futureKey: { value: 'keep-me', updatedAt: 99 },
    })
  })

  it('breaks equal-timestamp conflicts safely (vpn prefers true, others prefer remote)', () => {
    const res = resolveSettingsSync({
      account: ACCT_A,
      local: baseLocal({ vpn: false, listView: 'table' }),
      stored: {
        account: ACCT_A,
        entries: {
          vpn: { value: false, updatedAt: 4_000 },
          listView: { value: 'table', updatedAt: 4_000 },
        },
      },
      remote: {
        vpn: { value: true, updatedAt: 4_000 },
        listView: { value: 'cards', updatedAt: 4_000 },
      },
    })
    expect(res.apply).toEqual({ vpn: true, listView: 'cards' })
    expect(res.writeCloud).toBe(false)
  })

  it('drops previous account settings on switch without leaking prior-account values', () => {
    const res = resolveSettingsSync({
      account: ACCT_B,
      local: baseLocal({ vpn: false, language: 'fr', seedingPolicy: { ratio: 2, minutes: null } }),
      stored: {
        account: ACCT_A,
        entries: {
          vpn: { value: false, updatedAt: 9_000 },
          language: { value: 'fr', updatedAt: 9_000 },
          seedingPolicy: { value: { ratio: 2, minutes: null }, updatedAt: 9_000 },
        },
      },
      remote: {
        language: { value: 'ja', updatedAt: 3_000 },
      },
    })
    expect(res.writeCloud).toBe(false)
    expect(res.apply).toEqual({
      vpn: true,
      language: 'ja',
      seedingPolicy: { ratio: null, minutes: null },
    })
    expect(res.record).toEqual({
      account: ACCT_B,
      entries: {
        vpn: { value: true, updatedAt: 0 },
        language: { value: 'ja', updatedAt: 3_000 },
      },
    })
  })

  it('writes cloud when migrating legacy ripple/vpn.json even with no newer local edits', () => {
    const res = resolveSettingsSync({
      account: ACCT_A,
      local: baseLocal(),
      stored: undefined,
      remote: { vpn: { value: false, updatedAt: 1_234 } },
      migratedFromLegacyVpn: true,
    })
    expect(res.apply).toEqual({ vpn: false })
    expect(res.writeCloud).toBe(true)
    expect(res.cloudPayload).toEqual({ vpn: { value: false, updatedAt: 1_234 } })
  })
})

const makePartition = ({
  cloud,
  account,
  clock,
  readGate,
  writeGate,
}: {
  cloud: { payload: Record<string, SyncedEntry> | null, state?: 'ok' | 'locked' | 'error', migrated?: boolean }
  account: { name: string | null, available: boolean | null }
  clock: () => number
  readGate?: () => Promise<void>
  writeGate?: () => Promise<void>
}) => {
  let local = baseLocal()
  let stored: StoredSettingsSync | undefined
  const appliedPatches: Partial<SettingsValues>[] = []
  let readCalls = 0
  let writeCalls = 0

  const controller = createSettingsSyncController({
    vpnOffAvailable: () => true,
    readLocal: () => ({ ...local }),
    applyLocal: async (patch) => {
      local = { ...local, ...patch }
      appliedPatches.push(patch)
    },
    accountInfo: async () => account.name,
    fsAvailable: async () => account.available,
    readCloud: async (): Promise<CloudReadResult> => {
      readCalls += 1
      if (readCalls > 10) throw new Error('sync loop exceeded 10 reads')
      if (readGate) await readGate()
      if (cloud.state === 'locked') return { kind: 'locked' }
      if (cloud.state === 'error') return { kind: 'error' }
      if (cloud.payload === null) return { kind: 'absent' }
      const parsed = parseSettingsSync(cloud.payload)
      if (!parsed) return { kind: 'absent' }
      return { kind: 'ok', parsed, migratedFromLegacyVpn: !!cloud.migrated }
    },
    writeCloud: async (payload) => {
      writeCalls += 1
      if (writeGate) await writeGate()
      if (cloud.state === 'locked') return 'locked'
      cloud.payload = payload
      cloud.migrated = false
      return 'ok'
    },
    readStored: async () => stored,
    writeStored: async (updater) => { stored = updater(stored) },
    tagAccount: async (name) => `tag:${name}`,
    now: clock,
  })

  const setSetting = async <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    local = { ...local, [key]: value }
    return controller.recordChoice(key, value)
  }

  return {
    controller,
    setSetting,
    getLocal: () => local,
    setLocal: (patch: Partial<SettingsValues>) => { local = { ...local, ...patch } },
    stored: () => stored,
    appliedPatches,
    counts: () => ({ readCalls, writeCalls }),
  }
}

describe('createSettingsSyncController', () => {
  it('syncs every setting across standalone Ripple and Stub embed without losing concurrent edits', async () => {
    let tick = 1_000
    const cloud: { payload: Record<string, SyncedEntry> | null } = { payload: null }
    const sharedAccount = { name: 'alice', available: true }

    const ripple = makePartition({ cloud, account: sharedAccount, clock: () => ++tick })
    const stubEmbed = makePartition({ cloud, account: sharedAccount, clock: () => ++tick })

    expect(await ripple.controller.sync()).toBe('synced')
    expect(cloud.payload).toBeNull()

    // Stub toggles VPN off & audio normalization off; Ripple updates seedingPolicy & dockHeight
    expect(await stubEmbed.setSetting('vpn', false)).toBe('synced')
    expect(await stubEmbed.setSetting('normalizeVolume', false)).toBe('synced')
    expect(await ripple.setSetting('seedingPolicy', { ratio: 1.5, minutes: 30 })).toBe('synced')
    expect(await ripple.setSetting('dockHeight', 480)).toBe('synced')

    expect(await stubEmbed.controller.sync()).toBe('synced')
    expect(await ripple.controller.sync()).toBe('synced')

    expect(stubEmbed.getLocal()).toEqual(ripple.getLocal())
    expect(stubEmbed.getLocal().vpn).toBe(false)
    expect(stubEmbed.getLocal().normalizeVolume).toBe(false)
    expect(stubEmbed.getLocal().seedingPolicy).toEqual({ ratio: 1.5, minutes: 30 })
    expect(stubEmbed.getLocal().dockHeight).toBe(480)
  })

  it('lets a mid-flight setting change beat a skewed remote clock for that key', async () => {
    let releaseRead!: () => void
    let gated = true
    let tick = 1_000
    const cloud: { payload: Record<string, SyncedEntry> | null } = {
      payload: { seedingPolicy: { value: { ratio: null, minutes: null }, updatedAt: 12_000 } },
    }
    const account = { name: 'alice', available: true }

    const part = makePartition({
      cloud,
      account,
      clock: () => ++tick,
      readGate: () => (gated ? (gated = false, new Promise<void>((resolve) => { releaseRead = resolve })) : Promise.resolve()),
    })

    const inFlightSync = part.controller.sync()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const editSync = part.setSetting('seedingPolicy', { ratio: 2, minutes: null })
    releaseRead()

    await inFlightSync
    await editSync

    expect(part.getLocal().seedingPolicy).toEqual({ ratio: 2, minutes: null })
    expect(cloud.payload?.seedingPolicy?.value).toEqual({ ratio: 2, minutes: null })
    expect(cloud.payload!.seedingPolicy!.updatedAt).toBeGreaterThan(12_000)
  })

  it('converges without looping on account switch or local/IDB mismatch, and honors signed-out / locked states', async () => {
    let tick = 9_000
    const cloud: { payload: Record<string, SyncedEntry> | null, state?: 'ok' | 'locked' | 'error' } = { payload: null }
    const account: { name: string | null, available: boolean | null } = { name: null, available: false }
    const part = makePartition({ cloud, account, clock: () => ++tick })
    part.setLocal({ vpn: false })

    // Signed out: never reads/writes cloud
    expect(await part.controller.sync()).toBe('signed-out')
    expect(part.counts()).toEqual({ readCalls: 0, writeCalls: 0 })
    expect(part.getLocal().vpn).toBe(false)

    // Sign in to Alice -> seeds Alice's cloud
    account.name = 'alice'
    account.available = true
    expect(await part.controller.sync()).toBe('synced')
    expect(cloud.payload?.vpn?.value).toBe(false)

    // Locked / error states bail cleanly
    cloud.state = 'locked'
    expect(await part.controller.sync()).toBe('locked')
    cloud.state = 'error'
    expect(await part.controller.sync()).toBe('retry')
    cloud.state = 'ok'

    // Switch to Bob with empty cloud -> converges cleanly without looping
    const readsBefore = part.counts().readCalls
    account.name = 'bob'
    cloud.payload = null
    part.controller.noteAccountSwitch()
    expect(await part.controller.sync()).toBe('synced')
    expect(part.counts().readCalls - readsBefore).toBeLessThanOrEqual(2)
    expect(part.getLocal().vpn).toBe(true)

    // Local mismatch against IDB & older cloud record converges without looping
    await part.setSetting('listView', 'table')
    const readsBeforeMismatch = part.counts().readCalls
    part.setLocal({ listView: 'cards' })
    cloud.payload = { listView: { value: 'table', updatedAt: 3_000 } }
    expect(await part.controller.sync()).toBe('synced')
    expect(part.counts().readCalls - readsBeforeMismatch).toBeLessThanOrEqual(2)
    expect(part.getLocal().listView).toBe('table')
  })

  it('lets an existing cloud entry overwrite an unrecorded local change', async () => {
    let tick = 1_000
    const cloud: { payload: Record<string, SyncedEntry> | null } = {
      payload: { rateLimits: { value: { down: 500_000, up: 100_000 }, updatedAt: 1_500 } },
    }
    const account = { name: 'alice', available: true }
    const part = makePartition({ cloud, account, clock: () => ++tick })

    await part.controller.sync()
    expect(part.getLocal().rateLimits).toEqual({ down: 500_000, up: 100_000 })

    // Mutate local storage without calling recordChoice -> next sync reverts to cloud
    part.setLocal({ rateLimits: { down: 0, up: 50_000 } })
    expect(await part.controller.sync()).toBe('synced')
    expect(part.getLocal().rateLimits).toEqual({ down: 500_000, up: 100_000 })
  })

  it('uploads a choice recorded during the final MAX_RERUNS attempt immediately', async () => {
    const gates: (() => void)[] = []
    let holdWrites = true
    let tick = 1_000
    const cloud: { payload: Record<string, SyncedEntry> | null } = { payload: null }
    const account = { name: 'alice', available: true }
    const part = makePartition({
      cloud,
      account,
      clock: () => ++tick,
      writeGate: () => (holdWrites ? new Promise<void>((resolve) => { gates.push(resolve) }) : Promise.resolve()),
    })

    // Attempt 1 enters writeCloud; p2 lands mid-write -> overtaken rerun -> Attempt 2
    const p1 = part.setSetting('vpn', false)
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const p2 = part.setSetting('addDialog', true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    gates.shift()!()

    // Attempt 2 enters writeCloud; p3 lands mid-write -> overtaken rerun -> Attempt 3 (MAX_RERUNS)
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const p3 = part.setSetting('dockHeight', 400)
    await new Promise((resolve) => setTimeout(resolve, 10))
    gates.shift()!()

    // Attempt 3 enters writeCloud (final MAX_RERUNS iteration); p4 lands mid-write -> exits stale -> fresh follow-up sync
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    holdWrites = false
    const p4 = part.setSetting('listView', 'table')
    await new Promise((resolve) => setTimeout(resolve, 10))
    gates.shift()!()

    expect(await Promise.all([p1, p2, p3, p4])).toEqual(['synced', 'synced', 'synced', 'synced'])
    expect(cloud.payload?.listView?.value).toBe('table')
    expect(part.getLocal().listView).toBe('table')
  })

  it('keeps a post-switch choice made before the first sync while discarding other old-account entries', async () => {
    let tick = 1_000
    const cloud: { payload: Record<string, SyncedEntry> | null } = { payload: null }
    const account: { name: string | null, available: boolean | null } = { name: 'alice', available: true }
    const part = makePartition({ cloud, account, clock: () => ++tick })

    await part.setSetting('vpn', false)
    await part.setSetting('addDialog', true)
    await part.setSetting('listView', 'table')
    expect(cloud.payload?.vpn?.value).toBe(false)

    // Switch to Bob, and before Bob's first sync runs, change dockHeight locally
    account.name = 'bob'
    cloud.payload = { addDialog: { value: false, updatedAt: 2_000 } }
    part.controller.noteAccountSwitch()
    part.setLocal({ dockHeight: 420 })
    const outcome = await part.controller.recordChoice('dockHeight', 420)

    expect(outcome).toBe('synced')
    expect(part.getLocal().dockHeight).toBe(420)
    expect(cloud.payload?.dockHeight?.value).toBe(420)
    // Prior account's vpn=false and listView='table' were NOT leaked to Bob
    expect(part.getLocal().vpn).toBe(true)
    expect(part.getLocal().addDialog).toBe(false)
    expect(part.getLocal().listView).toBe('cards')
    expect(cloud.payload?.listView).toBeUndefined()
  })
})
