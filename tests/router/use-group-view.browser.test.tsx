import type { Persisted } from '../../src/torrent/library'
import type { Torrent } from '../../src/torrent/types'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { del, get, set } from 'idb-keyval'

import { GROUPS_KEY, createGroup, takeOutOfGroup, torrentsIn } from '../../src/torrent/groups'
import type { StoredGroups } from '../../src/torrent/groups'
import { torrentKey } from '../../src/torrent/library'
import { LIST_GROUP_KEY } from '../../src/torrent/list-view'
import { GROUP_LINK_PREFIX, MAX_LINK_TORRENTS, readGroupLink } from '../../src/router/group-link'
import { addLinkedGroup, receivable, useGroupLink, useGroupView } from '../../src/router/use-group-view'

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

const storedGroups = async () => (await get<StoredGroups>(GROUPS_KEY))?.groups.filter((g) => g.deletedAt === undefined) ?? []

const str = (value: string) => `${value.length}:${value}`
// a .torrent of one 11-byte file whose info dictionary says private, as a private tracker hands one out
const PRIVATE_TORRENT = new TextEncoder().encode(`d${str('announce')}${str('https://members.example/announce')}${str('info')}d${str('length')}i11e${str('name')}${str('Members')}${str('piece length')}i16384e${str('pieces')}${str('p'.repeat(20))}${str('private')}i1eee`)

describe('a group sent by link', () => {
  const linked = { name: ' Week 2 ', torrents: [hash('a'), hash('b')].map((infoHash) => ({ infoHash, magnet: `magnet:?xt=urn:btih:${infoHash}&tr=udp%3A%2F%2Ft.example%3A1` })) }

  it('goes in the list in one import, each torrent in its own folder and added now, and in a group of its name', async () => {
    const imported: Persisted[][] = []
    const before = Date.now()
    const id = await addLinkedGroup(linked, [], (list) => imported.push(list))
    expect(imported).toHaveLength(1)
    expect(imported[0]!.map(({ infoHash, magnet, savePath }) => ({ infoHash, magnet, savePath }))).toEqual([
      { infoHash: hash('a'), magnet: linked.torrents[0]!.magnet, savePath: `/dl/${hash('a')}` },
      { infoHash: hash('b'), magnet: linked.torrents[1]!.magnet, savePath: `/dl/${hash('b')}` },
    ])
    for (const entry of imported[0]!) expect(entry.addedAt).toBeGreaterThanOrEqual(before)
    const groups = await storedGroups()
    expect(groups.map((g) => [g.id, g.name, [...torrentsIn(g)].sort()])).toEqual([[id, 'Week 2', [hash('a'), hash('b')]]])
  })

  it('fills the group of its name that holds only torrents it names, and makes a new one beside any other', async () => {
    const subset = (await createGroup('Week 2', [hash('a')]))!
    expect(await addLinkedGroup(linked, await storedGroups(), () => {}), 'opened again').toBe(subset)
    expect(await heldBy(subset)).toEqual([hash('a'), hash('b')])
    expect(await storedGroups()).toHaveLength(1)

    await del(GROUPS_KEY)
    const other = (await createGroup('Week 2', [hash('a'), hash('c')]))!
    const made = await addLinkedGroup(linked, await storedGroups(), () => {})
    expect(made).not.toBe(other)
    expect(await heldBy(other), 'a torrent the link does not name').toEqual([hash('a'), hash('c')])
    expect(await heldBy(made!)).toEqual([hash('a'), hash('b')])

    await del(GROUPS_KEY)
    const long = { ...linked, name: 'x'.repeat(300) }
    const first = await addLinkedGroup(long, [], () => {})
    expect(await addLinkedGroup(long, await storedGroups(), () => {}), 'a name past 200 characters, opened again').toBe(first)
  })
})

describe('a group read from a link, before it is asked about', () => {
  const magnet = (c: string, length: number) => {
    const head = `magnet:?xt=urn:btih:${hash(c)}&tr=`
    return head + 'a'.repeat(length - head.length)
  }

  it('keeps 200 characters of its name, trimmed, and is refused once its magnets add up past 1 MiB', () => {
    expect(receivable(null)).toBeNull()
    const torrents = [{ infoHash: hash('a'), magnet: magnet('a', 512 * 1024) }, { infoHash: hash('b'), magnet: magnet('b', 512 * 1024) }]
    expect(receivable({ name: ` ${'x'.repeat(300)} `, torrents })).toEqual({ name: 'x'.repeat(200), torrents })
    expect(receivable({ name: 'Week 2', torrents: [torrents[0]!, { infoHash: hash('b'), magnet: magnet('b', 512 * 1024 + 1) }] })).toBeNull()
  })
})

describe('a group\'s link', () => {
  afterAll(() => del(torrentKey(hash('c'))))

  it('is built from its rows\' magnets once they are read, leaving out a private one and counting it', async () => {
    await set(torrentKey(hash('c')), PRIVATE_TORRENT)
    const rows = [torrent('a'), torrent('b'), torrent('c')]
    const { result } = await renderHook(() => useGroupLink('Week 2', rows))
    await expect.poll(() => result.current).not.toBeNull()
    expect(result.current).toMatchObject({ count: 2, privateLeftOut: 1 })
    expect(result.current!.link!.startsWith(GROUP_LINK_PREFIX)).toBe(true)
    const read = readGroupLink(result.current!.link!.slice(GROUP_LINK_PREFIX.length))
    expect(read?.name).toBe('Week 2')
    expect(read?.torrents.map((t) => t.infoHash).sort()).toEqual([hash('a'), hash('b')])
  })

  it('is none past the most a link holds, still counted, so Copy link can say why', async () => {
    const rows = Array.from({ length: MAX_LINK_TORRENTS + 1 }, (_, i) => torrent('a', { id: String(i), infoHash: i.toString(16).padStart(40, '0'), magnet: `magnet:?xt=urn:btih:${i.toString(16).padStart(40, '0')}` }))
    const { result } = await renderHook(() => useGroupLink('Week 2', rows))
    await expect.poll(() => result.current, { timeout: 10_000 }).not.toBeNull()
    expect(result.current).toMatchObject({ link: null, count: MAX_LINK_TORRENTS + 1, privateLeftOut: 0 })
  })
})
