import { describe, expect, it } from 'vitest'

import { createVpnSyncController, parseVpnSync, resolveVpnSync } from '../../src/torrent/vpn-sync'
import type { StoredVpnSync, VpnSyncRecord } from '../../src/torrent/vpn-sync'

const ACCT_A = 'a'.repeat(64)
const ACCT_B = 'b'.repeat(64)

describe('parseVpnSync', () => {
  it('accepts valid records and rejects malformed payloads', () => {
    expect(parseVpnSync({ on: true, updatedAt: 0 })).toEqual({ on: true, updatedAt: 0 })
    expect(parseVpnSync({ on: false, updatedAt: 1_700_000_000_000, extra: 'ignored' })).toEqual({
      on: false,
      updatedAt: 1_700_000_000_000,
    })

    for (const bad of [
      null,
      undefined,
      'off',
      [],
      { on: 'true', updatedAt: 10 },
      { on: true, updatedAt: -1 },
      { on: true, updatedAt: 1.5 },
      { on: true, updatedAt: Number.NaN },
      { on: true, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      { updatedAt: 10 },
      { on: false },
    ]) {
      expect(parseVpnSync(bad)).toBeNull()
    }
  })
})

describe('resolveVpnSync', () => {
  it('avoids noisy writes for untouched default state when cloud has no record', () => {
    expect(resolveVpnSync({ account: ACCT_A, localOn: true, stored: undefined, remote: null, now: 500 })).toEqual({
      record: { account: ACCT_A, on: true, updatedAt: 0 },
      applyLocal: false,
      writeCloud: false,
    })
  })

  it('adopts a dated remote record for an untouched default partition', () => {
    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: true,
      stored: undefined,
      remote: { on: false, updatedAt: 1_000 },
      now: 2_000,
    })).toEqual({
      record: { account: ACCT_A, on: false, updatedAt: 1_000 },
      applyLocal: true,
      writeCloud: false,
    })
  })

  it('picks latest updatedAt across local and remote mutations', () => {
    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: false,
      stored: { account: ACCT_A, on: false, updatedAt: 2_000 },
      remote: { on: true, updatedAt: 1_000 },
    })).toEqual({
      record: { account: ACCT_A, on: false, updatedAt: 2_000 },
      applyLocal: false,
      writeCloud: true,
    })

    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: false,
      stored: { account: ACCT_A, on: false, updatedAt: 2_000 },
      remote: { on: true, updatedAt: 3_000 },
    })).toEqual({
      record: { account: ACCT_A, on: true, updatedAt: 3_000 },
      applyLocal: true,
      writeCloud: false,
    })
  })

  it('breaks equal-timestamp conflicts in favor of VPN on', () => {
    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: false,
      stored: { account: ACCT_A, on: false, updatedAt: 4_000 },
      remote: { on: true, updatedAt: 4_000 },
    })).toEqual({
      record: { account: ACCT_A, on: true, updatedAt: 4_000 },
      applyLocal: true,
      writeCloud: false,
    })

    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: true,
      stored: { account: ACCT_A, on: true, updatedAt: 4_000 },
      remote: { on: false, updatedAt: 4_000 },
    })).toEqual({
      record: { account: ACCT_A, on: true, updatedAt: 4_000 },
      applyLocal: false,
      writeCloud: true,
    })
  })

  it('seeds cloud when a partition has pre-existing local off state and cloud is empty', () => {
    expect(resolveVpnSync({
      account: ACCT_A,
      localOn: false,
      stored: undefined,
      remote: null,
      now: 12_345,
    })).toEqual({
      record: { account: ACCT_A, on: false, updatedAt: 12_345 },
      applyLocal: false,
      writeCloud: true,
    })
  })

  it('drops previous account state on account switch instead of leaking VPN off', () => {
    expect(resolveVpnSync({
      account: ACCT_B,
      localOn: false,
      stored: { account: ACCT_A, on: false, updatedAt: 9_000 },
      remote: null,
    })).toEqual({
      record: { account: ACCT_B, on: true, updatedAt: 0 },
      applyLocal: true,
      writeCloud: false,
    })

    expect(resolveVpnSync({
      account: ACCT_B,
      localOn: false,
      stored: { account: ACCT_A, on: false, updatedAt: 9_000 },
      remote: { on: false, updatedAt: 3_000 },
    })).toEqual({
      record: { account: ACCT_B, on: false, updatedAt: 3_000 },
      applyLocal: false,
      writeCloud: false,
    })
  })
})

type FakePartitionOptions = {
  cloud: { value: VpnSyncRecord | null | 'locked' | 'error' }
  account: { name: string | null, available: boolean | null }
  clock: () => number
  readGate?: () => Promise<void>
}

const makePartition = ({ cloud, account, clock, readGate }: FakePartitionOptions) => {
  let localOn = true
  let stored: StoredVpnSync | undefined
  const setVpnCalls: boolean[] = []
  let readCalls = 0
  let writeCalls = 0

  const controller = createVpnSyncController({
    vpnOffAvailable: () => true,
    vpnOn: () => localOn,
    setVpn: async (on: boolean) => {
      localOn = on
      setVpnCalls.push(on)
    },
    accountInfo: async () => account.name,
    fsAvailable: async () => account.available,
    readCloud: async () => {
      readCalls += 1
      if (readGate) await readGate()
      if (cloud.value === null) return 'absent'
      return cloud.value
    },
    writeCloud: async (record) => {
      writeCalls += 1
      if (cloud.value === 'locked') return 'locked'
      cloud.value = { on: record.on, updatedAt: record.updatedAt }
      return 'ok'
    },
    readStored: async () => stored,
    writeStored: async (updater) => { stored = updater(stored) },
    tagAccount: async (name) => `tag:${name}`,
    now: clock,
  })

  const press = async (on: boolean) => {
    localOn = on
    return controller.recordChoice(on)
  }

  return {
    controller,
    press,
    isOn: () => localOn,
    setLocalOn: (on: boolean) => { localOn = on },
    stored: () => stored,
    setVpnCalls,
    counts: () => ({ readCalls, writeCalls }),
  }
}

describe('createVpnSyncController', () => {
  it('syncs APP-843 two-partition toggles between Stub embed and standalone Ripple', async () => {
    let tick = 1_000
    const cloud: { value: VpnSyncRecord | null } = { value: null }
    const sharedAccount = { name: 'alice', available: true }

    const ripple = makePartition({ cloud, account: sharedAccount, clock: () => ++tick })
    const stubEmbed = makePartition({ cloud, account: sharedAccount, clock: () => ++tick })

    expect(await ripple.controller.sync()).toBe('synced')
    expect(ripple.isOn()).toBe(true)
    expect(cloud.value).toBeNull()

    // User turns VPN off inside Stub's embedded /watch frame
    expect(await stubEmbed.press(false)).toBe('synced')
    expect(stubEmbed.isOn()).toBe(false)
    expect(cloud.value?.on).toBe(false)

    // User switches back to standalone Ripple tab; sync updates it immediately without reload
    expect(await ripple.controller.sync()).toBe('synced')
    expect(ripple.isOn()).toBe(false)
    expect(ripple.setVpnCalls).toEqual([false])

    // Standalone Ripple turns VPN back on -> Stub embed follows on its next sync
    expect(await ripple.press(true)).toBe('synced')
    expect(cloud.value?.on).toBe(true)
    expect(await stubEmbed.controller.sync()).toBe('synced')
    expect(stubEmbed.isOn()).toBe(true)
    expect(stubEmbed.setVpnCalls).toEqual([true])
  })

  it('lets a mid-flight user click beat an older cloud read even under remote clock skew', async () => {
    let releaseRead!: () => void
    let gated = true
    let tick = 1_000
    // Remote timestamp is 10s ahead of local clock while user initiates a click mid-read
    const cloud: { value: VpnSyncRecord | null } = { value: { on: true, updatedAt: 12_000 } }
    const sharedAccount = { name: 'alice', available: true }

    const part = makePartition({
      cloud,
      account: sharedAccount,
      clock: () => ++tick,
      readGate: () => (gated ? (gated = false, new Promise<void>((resolve) => { releaseRead = resolve })) : Promise.resolve()),
    })

    const inFlightSync = part.controller.sync()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const clickSync = part.press(false)
    releaseRead()

    await inFlightSync
    await clickSync

    expect(part.isOn()).toBe(false)
    expect(part.setVpnCalls).toEqual([])
    expect(cloud.value?.on).toBe(false)
    expect(cloud.value!.updatedAt).toBeGreaterThan(12_000)
  })

  it('aborts stale work cleanly when account switches mid-read', async () => {
    let releaseRead!: () => void
    const cloud: { value: VpnSyncRecord | null } = { value: { on: false, updatedAt: 5_000 } }
    const account = { name: 'alice', available: true }
    let tick = 10_000
    let block = true

    const part = makePartition({
      cloud,
      account,
      clock: () => ++tick,
      readGate: () => block ? new Promise<void>((resolve) => { block = false; releaseRead = resolve }) : Promise.resolve(),
    })

    const syncPromise = part.controller.sync()
    await new Promise((resolve) => setTimeout(resolve, 10))
    account.name = 'bob'
    part.controller.noteAccountSwitch()
    releaseRead()

    expect(await syncPromise).toBe('stale')
    expect(part.isOn()).toBe(true)
    expect(part.setVpnCalls).toEqual([])
  })

  it('does nothing when signed out, locked, or hit by a transient read error', async () => {
    let tick = 10_000
    const cloud: { value: VpnSyncRecord | null | 'locked' | 'error' } = { value: 'locked' }
    const account: { name: string | null, available: boolean | null } = { name: null, available: false }
    const part = makePartition({ cloud, account, clock: () => ++tick })
    part.setLocalOn(false)

    // Signed out: never reads or writes cloud and preserves local state
    expect(await part.controller.sync()).toBe('signed-out')
    expect(part.counts()).toEqual({ readCalls: 0, writeCalls: 0 })
    expect(part.isOn()).toBe(false)

    // Locked E2E scope: quietly defers without altering local state or writing cloud
    account.name = 'alice'
    account.available = true
    expect(await part.controller.sync()).toBe('locked')
    expect(part.counts()).toEqual({ readCalls: 1, writeCalls: 0 })
    expect(part.isOn()).toBe(false)

    // Transient read failure: asks for retry without clobbering local state or cloud
    cloud.value = 'error'
    expect(await part.controller.sync()).toBe('retry')
    expect(part.counts()).toEqual({ readCalls: 2, writeCalls: 0 })
    expect(part.isOn()).toBe(false)
  })
})
