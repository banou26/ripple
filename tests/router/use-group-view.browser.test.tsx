import type { Torrent } from '../../src/torrent/types'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { del, get } from 'idb-keyval'

import { GROUPS_KEY, createGroup, takeOutOfGroup, torrentsIn } from '../../src/torrent/groups'
import type { StoredGroups } from '../../src/torrent/groups'
import { LIST_GROUP_KEY } from '../../src/torrent/list-view'
import { useGroupView } from '../../src/router/use-group-view'

const hash = (c: string) => c.repeat(40)

const torrent = (c: string, over: Partial<Torrent> = {}): Torrent => ({
  id: c, infoHash: hash(c), magnet: `magnet:?xt=urn:btih:${hash(c)}`, name: c, size: 0, downloaded: 0, progress: 0,
  state: 'downloading', down: 0, up: 0, peers: 0, seeds: 0, eta: '', flags: 0, queuePosition: -1, stats: null, addedAt: 1,
  ...over,
})

const heldBy = async (id: string) => {
  const group = (await get<StoredGroups>(GROUPS_KEY))?.groups.find((g) => g.id === id)
  return group ? [...torrentsIn(group)].sort() : undefined
}

beforeEach(async () => {
  localStorage.removeItem(LIST_GROUP_KEY)
  await del(GROUPS_KEY)
})
afterAll(async () => {
  localStorage.removeItem(LIST_GROUP_KEY)
  await del(GROUPS_KEY)
})

describe('the group shown', () => {
  it('is remembered by its id, and a stored id that names no group shows every torrent', async () => {
    const id = (await createGroup('Week 2', [hash('a')]))!
    const { result } = await renderHook(() => useGroupView([]))
    await expect.poll(() => result.current.groups?.length).toBe(1)
    expect(result.current.group).toBeUndefined()
    result.current.choose(id)
    await expect.poll(() => result.current.group?.name).toBe('Week 2')
    expect([...result.current.members!]).toEqual([hash('a')])
    expect(localStorage.getItem(LIST_GROUP_KEY)).toBe(id)

    const again = await renderHook(() => useGroupView([]))
    await expect.poll(() => again.result.current.group?.id).toBe(id)
    result.current.choose(null)
    expect(localStorage.getItem(LIST_GROUP_KEY)).toBeNull()

    localStorage.setItem(LIST_GROUP_KEY, 'a group deleted elsewhere')
    const gone = await renderHook(() => useGroupView([]))
    await expect.poll(() => gone.result.current.groups?.length).toBe(1)
    expect(gone.result.current.group).toBeUndefined()
    expect(gone.result.current.members).toBeUndefined()
  })

  /**
   * Only a torrent a person adds here while the group is shown: never one the list held already, one from sync, a
   * player's temporary one, or one taken out of the group on purpose.
   */
  it('takes in a kept torrent added on this device while it is shown, and no other', async () => {
    const id = (await createGroup('Week 2', [hash('a'), hash('f')]))!
    await takeOutOfGroup(id, [hash('f')])
    const { result, rerender } = await renderHook((props?: { torrents: Torrent[] }) => useGroupView(props!.torrents), { initialProps: { torrents: [torrent('a')] } })
    await expect.poll(() => result.current.groups?.length).toBe(1)
    // added after this tab opened, before the group was shown
    const before = [torrent('a'), torrent('b', { addedAt: Date.now() })]
    await rerender({ torrents: before })
    await new Promise((resolve) => setTimeout(resolve, 5))
    result.current.choose(id)
    await expect.poll(() => result.current.group?.id).toBe(id)

    const now = Date.now() + 1
    await rerender({
      torrents: [
        ...before,
        torrent('c', { addedAt: now }),
        torrent('d', { addedAt: now, state: 'missing' }),
        torrent('e', { addedAt: now, ephemeral: true }),
        torrent('f', { addedAt: now }),
        torrent('9', { addedAt: now, infoHash: undefined }),
      ],
    })
    await expect.poll(() => heldBy(id)).toEqual([hash('a'), hash('c')])
  })

  it('takes in nothing the list held when a tab opened already showing the group', async () => {
    const id = (await createGroup('Week 2', []))!
    localStorage.setItem(LIST_GROUP_KEY, id)
    const { result, rerender } = await renderHook((props?: { torrents: Torrent[] }) => useGroupView(props!.torrents), { initialProps: { torrents: [torrent('b')] } })
    await expect.poll(() => result.current.group?.id).toBe(id)
    await rerender({ torrents: [torrent('b'), torrent('c', { addedAt: Date.now() + 1 })] })
    await expect.poll(() => heldBy(id)).toEqual([hash('c')])
  })

  it('takes in nothing while every torrent is shown', async () => {
    const id = (await createGroup('Week 2', []))!
    const { result, rerender } = await renderHook((props?: { torrents: Torrent[] }) => useGroupView(props!.torrents), { initialProps: { torrents: [] as Torrent[] } })
    await expect.poll(() => result.current.groups?.length).toBe(1)
    await rerender({ torrents: [torrent('c', { addedAt: Date.now() + 1 })] })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await heldBy(id)).toEqual([])
  })
})
