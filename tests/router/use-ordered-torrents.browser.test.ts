import type { Torrent } from '../../src/torrent/types'
import type { SortDir } from '../../src/torrent/list-view'

import { expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useOrderedTorrents } from '../../src/router/use-ordered-torrents'

const t = (id: string, down: number, state: Torrent['state'] = 'downloading'): Torrent => ({
  id, infoHash: id.padStart(40, '0'), name: id, size: 1_000, downloaded: 0, progress: 0.5, state, down, up: 0, peers: 0,
  seeds: 0, eta: '-', flags: 0, queuePosition: -1, stats: null, addedAt: 0,
})

const mount = async (torrents: Torrent[]) => {
  const clock = { now: 1_000_000 }
  const hook = await renderHook(
    (props?: { torrents: Torrent[], dir: SortDir }) => useOrderedTorrents(props!.torrents, 'all', 'down', props!.dir, () => clock.now),
    { initialProps: { torrents, dir: 'desc' } },
  )
  const drawn = () => hook.result.current.rows.map((x) => `${x.id} ${hook.result.current.groupOf(x)}`)
  hook.result.current.interaction.onPointerEnter()
  return { clock, drawn, rerender: hook.rerender }
}

// a new sort is somebody asking for a new arrangement, so it is drawn at once even while the pointer holds the list
it('rearranges a held list and its headings at once on a new sort, and keeps them', async () => {
  const { clock, drawn, rerender } = await mount([t('a', 3), t('b', 2), t('c', 1)])
  clock.now += 2_500
  await rerender({ torrents: [t('a', 1), t('b', 3), t('c', 2)], dir: 'desc' })
  expect(drawn()).toEqual(['a active', 'b active', 'c active'])
  const moved = [t('a', 1, 'paused'), t('b', 3), t('c', 2)]
  await rerender({ torrents: moved, dir: 'asc' })
  expect(drawn()).toEqual(['a paused', 'c active', 'b active'])
  clock.now += 500
  await rerender({ torrents: moved.map((x) => ({ ...x })), dir: 'asc' })
  expect(drawn()).toEqual(['a paused', 'c active', 'b active'])
})

it('times a held heading from the row that moved, not from a torrent removed before it', async () => {
  const { clock, drawn, rerender } = await mount([t('a', 3), t('b', 2), t('c', 1)])
  await rerender({ torrents: [t('a', 3), t('b', 2)], dir: 'desc' })
  clock.now += 9_000
  const paused = [t('a', 3), t('b', 2, 'paused')]
  await rerender({ torrents: paused, dir: 'desc' })
  clock.now += 2_000
  await rerender({ torrents: paused.map((x) => ({ ...x })), dir: 'desc' })
  expect(drawn()).toEqual(['a active', 'b active'])
})

it('stands a row under its own heading as soon as the engine reports it, with the pointer in the list', async () => {
  const { clock, drawn, rerender } = await mount([t('a', 3), t('b', 2, 'starting')])
  clock.now += 100
  await rerender({ torrents: [t('a', 3), t('b', 2, 'seeding')], dir: 'desc' })
  expect(drawn()).toEqual(['a active', 'b done'])
})

it('stands a row still starting at a release under its own heading once reported', async () => {
  const { clock, drawn, rerender } = await mount([t('a', 3), t('b', 2), t('c', 1, 'starting')])
  const paused = [t('a', 3, 'paused'), t('b', 2), t('c', 1, 'starting')]
  await rerender({ torrents: paused, dir: 'desc' })
  expect(drawn()).toEqual(['a active', 'b active', 'c active'])
  clock.now += 10_500
  await rerender({ torrents: paused.map((x) => ({ ...x })), dir: 'desc' })
  expect(drawn()).toEqual(['a paused', 'b active', 'c active'])
  clock.now += 100
  await rerender({ torrents: [t('a', 3, 'paused'), t('b', 2), t('c', 1, 'seeding')], dir: 'desc' })
  expect(drawn()).toEqual(['a paused', 'b active', 'c done'])
})

it('stands a torrent removed and added again under its new heading at once', async () => {
  const { drawn, rerender } = await mount([t('a', 3), t('b', 2, 'seeding')])
  await rerender({ torrents: [t('a', 3)], dir: 'desc' })
  await rerender({ torrents: [t('a', 3), t('b', 2, 'paused')], dir: 'desc' })
  expect(drawn()).toEqual(['a active', 'b paused'])
})
