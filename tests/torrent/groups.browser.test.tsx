import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { del, get, set } from 'idb-keyval'

import {
  GROUPS_KEY, createGroup, deleteGroup, mergeGroups, putInGroup, renameGroup, subscribeGroups, takeOutOfGroup, torrentsIn,
  useGroups,
} from '../../src/torrent/groups'
import type { StoredGroups, TorrentGroup } from '../../src/torrent/groups'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const stored = () => get<StoredGroups>(GROUPS_KEY)
const storedGroup = async (id: string) => (await stored())?.groups.find((g) => g.id === id)
const held = (g: TorrentGroup | undefined) => (g ? [...torrentsIn(g)].sort() : undefined)

// what another tab does: write the key, then say so on a channel object of its own
const editFromAnotherTab = async (value: StoredGroups) => {
  await set(GROUPS_KEY, value)
  const other = new BroadcastChannel('ripple:groups')
  other.postMessage(null)
  other.close()
}

beforeEach(async () => {
  await del(GROUPS_KEY)
})

describe('the group store', () => {
  // first, because a tab that has never edited must hear the others too, and an edit opens the channel
  it('shows, sorted by name, an edit made in another tab once that tab says so', async () => {
    const { result } = await renderHook(() => useGroups())
    await expect.poll(() => result.current).toEqual([])

    // ids in the opposite order to the names, so only a sort by name passes
    await set(GROUPS_KEY, {
      account: null,
      groups: [
        { id: 'other-tab-group1', name: 'Week 10', namedAt: 1, members: [{ infoHash: A, at: 1 }] },
        { id: 'other-tab-group2', name: 'Week 2', namedAt: 1, members: [] },
        { id: 'other-tab-group3', name: 'Apple', namedAt: 1, members: [] },
      ],
    } satisfies StoredGroups)
    // control: a write nobody announced is not picked up on its own, so the notice is what delivers
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(result.current).toEqual([])

    await editFromAnotherTab((await stored())!)
    await expect.poll(() => result.current?.map((g) => g.name)).toEqual(['Apple', 'Week 2', 'Week 10'])
  })

  it('shows a new group, sorted by name, and refuses a name that is empty once trimmed', async () => {
    const { result } = await renderHook(() => useGroups())
    await expect.poll(() => result.current).toEqual([])

    const weekend = await createGroup('  Weekend watch list ', [A, B])
    const orbital = await createGroup('Orbital Gardeners', [C])
    expect(await createGroup('   ', [A])).toBeNull()

    await expect.poll(() => result.current?.map((g) => g.name)).toEqual(['Orbital Gardeners', 'Weekend watch list'])
    expect(held(result.current?.find((g) => g.id === weekend))).toEqual([A, B])
    expect(held(result.current?.find((g) => g.id === orbital))).toEqual([C])
    expect(weekend).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect((await stored())?.groups).toHaveLength(2)
  })

  it('puts in, takes out, renames and deletes, and a deleted group leaves the view', async () => {
    const { result } = await renderHook(() => useGroups())
    const id = (await createGroup('Orbital Gardeners', [A]))!

    await putInGroup(id, [B, C])
    await takeOutOfGroup(id, [A])
    await renameGroup(id, 'Orbital Gardeners S01')
    expect(held(await storedGroup(id))).toEqual([B, C])
    expect((await storedGroup(id))?.name).toBe('Orbital Gardeners S01')
    await expect.poll(() => result.current?.map((g) => g.name)).toEqual(['Orbital Gardeners S01'])

    // an empty name is not saved
    await renameGroup(id, '  ')
    expect((await storedGroup(id))?.name).toBe('Orbital Gardeners S01')

    await deleteGroup(id)
    const tombstone = await storedGroup(id)
    expect(tombstone).toMatchObject({ id, name: '', members: [] })
    expect(tombstone?.deletedAt).toBeTypeOf('number')
    await expect.poll(() => result.current).toEqual([])
  })

  it('keeps every edit when several race, since each is a merge inside one transaction', async () => {
    const id = (await createGroup('Orbital Gardeners', [A]))!
    await Promise.all([
      putInGroup(id, [B]),
      putInGroup(id, [C]),
      takeOutOfGroup(id, [A]),
      renameGroup(id, 'Renamed'),
    ])
    expect(held(await storedGroup(id))).toEqual([B, C])
    expect((await storedGroup(id))?.name).toBe('Renamed')
  })

  it('does nothing on a group this browser does not hold', async () => {
    // what a tab still holding a record from before an account switch would send
    await set(GROUPS_KEY, { account: 'second', groups: [] } satisfies StoredGroups)
    await renameGroup('gone-gone-gone-g', 'Old account group')
    await putInGroup('gone-gone-gone-g', [A])
    await takeOutOfGroup('gone-gone-gone-g', [A])
    await deleteGroup('gone-gone-gone-g')
    expect(await stored()).toEqual({ account: 'second', groups: [] })

    const id = (await createGroup('Deleted', [A]))!
    await deleteGroup(id)
    const tombstone = await storedGroup(id)
    await putInGroup(id, [B])
    await renameGroup(id, 'Back')
    expect(await storedGroup(id)).toEqual(tombstone)
  })

  it('writes nothing and tells no one on an edit that changes nothing', async () => {
    let heard = 0
    let told = 0
    const off = subscribeGroups(() => { heard++ })
    const other = new BroadcastChannel('ripple:groups')
    other.onmessage = () => { told++ }
    try {
      const id = (await createGroup('Orbital Gardeners', [A]))!
      const gone = (await createGroup('Gone', [A]))!
      await deleteGroup(gone)
      await expect.poll(() => told).toBe(3)
      const before = await stored()
      const heardBefore = heard

      await putInGroup(id, [A])
      await takeOutOfGroup(id, [B])
      await renameGroup(id, ' Orbital Gardeners ')
      await putInGroup(gone, [B])
      await takeOutOfGroup(gone, [A])
      await renameGroup(gone, 'Back')
      await deleteGroup(gone)
      expect(await stored()).toEqual(before)

      // control: one real edit is heard, and a channel delivers in order, so a notice from the edits above came first
      await putInGroup(id, [B])
      await expect.poll(() => told).toBe(4)
      expect(heard).toBe(heardBefore + 1)
    } finally {
      off()
      other.close()
    }
  })

  it('leaves a torrent already in unstamped, so a take-out made earlier on another device stands', async () => {
    // this device still shows A in; another took A out at 2,000 and has not synced yet
    await set(GROUPS_KEY, {
      account: null,
      groups: [{ id: 'two-devices-grp', name: 'Shared', namedAt: 1_000, members: [{ infoHash: A, at: 1_000 }] }],
    } satisfies StoredGroups)
    await putInGroup('two-devices-grp', [A, B])
    const otherDevice = { id: 'two-devices-grp', name: 'Shared', namedAt: 1_000, members: [{ infoHash: A, at: 2_000, out: true }] }
    expect(held(mergeGroups((await stored())!.groups, [otherDevice])[0])).toEqual([B])
  })

  it('lets a rename win over a name stamped in the future by a clock that runs fast', async () => {
    const future = Date.now() + 10 * 60_000
    await set(GROUPS_KEY, {
      account: null,
      groups: [{ id: 'fast-clock-name0', name: 'From a fast clock', namedAt: future, members: [{ infoHash: A, at: 1 }] }],
    } satisfies StoredGroups)
    // a name that sorts lower, so a tie on the time cannot save it
    await renameGroup('fast-clock-name0', 'Aaa renamed here')
    const g = await storedGroup('fast-clock-name0')
    expect(g?.name).toBe('Aaa renamed here')
    expect(g!.namedAt).toBeGreaterThan(future)
  })

  it('lets a take-out, then a put back, win over an add stamped in the future by a clock that runs fast', async () => {
    const future = Date.now() + 10 * 60_000
    await set(GROUPS_KEY, {
      account: null,
      groups: [{ id: 'fast-clock-add00', name: 'Named long ago', namedAt: 1, members: [{ infoHash: A, at: future }] }],
    } satisfies StoredGroups)
    await takeOutOfGroup('fast-clock-add00', [A])
    expect(held(await storedGroup('fast-clock-add00'))).toEqual([])
    await putInGroup('fast-clock-add00', [A])
    expect(held(await storedGroup('fast-clock-add00'))).toEqual([A])
  })

  it('keeps the account the stored copy belongs to', async () => {
    await set(GROUPS_KEY, {
      account: 'someone',
      groups: [{ id: 'account-group-01', name: 'Mine', namedAt: 1, members: [] }],
    } satisfies StoredGroups)
    await putInGroup('account-group-01', [A])
    await createGroup('Another', [B])
    expect((await stored())?.account).toBe('someone')
  })

  it('tells this tab and the others about an edit made here', async () => {
    let heard = 0
    const off = subscribeGroups(() => { heard++ })
    const other = new BroadcastChannel('ripple:groups')
    let told = 0
    other.onmessage = () => { told++ }
    try {
      await expect.poll(() => heard).toBe(1)
      await createGroup('Orbital Gardeners', [A])
      // this tab's listeners are told directly, since a channel never delivers to its poster
      expect(heard).toBe(2)
      await expect.poll(() => told).toBe(1)
    } finally {
      off()
      other.close()
    }
  })
})
