import type { Torrent } from '../../src/torrent/types'
import type { ShareableMagnets } from '../../src/torrent/use-shareable-magnet'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { torrentKey } from '../../src/torrent/library'
import { magnetParam, magnetParams } from '../../src/torrent/magnet'
import { useShareableMagnets } from '../../src/torrent/use-shareable-magnet'

/** The `.torrent` files this device kept, by key, as idb-keyval holds them; every key read, and reads held back. */
const kept = new Map<string, Uint8Array>()
const asked: string[] = []
const held = new Map<string, Promise<void>>()
vi.mock('idb-keyval', () => ({ get: async (key: string) => { asked.push(key); await held.get(key); return kept.get(key) } }))

const encoder = new TextEncoder()
const str = (value: string) => `${encoder.encode(value).length}:${value}`
const torrentFile = (name: string, { tracker, flag }: { tracker: string, flag?: number }) => encoder.encode(
  'd' + str('announce') + str(tracker)
  + str('info') + 'd' + str('length') + 'i11e' + str('name') + str(name) + str('piece length') + 'i16384e' + str('pieces') + str('p'.repeat(20))
  + (flag === undefined ? '' : str('private') + `i${flag}e`)
  + 'ee',
)

const row = (hash: string, name: string): Torrent => ({
  id: hash, magnet: `magnet:?xt=urn:btih:${hash.repeat(40)}`, infoHash: hash.repeat(40), name, size: 11, downloaded: 0,
  progress: 0, state: 'downloading', down: 0, up: 0, peers: 0, seeds: 0, eta: '-', flags: 0, queuePosition: -1, stats: null, addedAt: 1,
})

// a, its file kept with a tracker; b, a magnet add with no file; p, private; z, whose private flag is 0 and so is not
kept.set(torrentKey('a'.repeat(40)), torrentFile('Kept', { tracker: 'https://tracker.example/announce' }))
kept.set(torrentKey('c'.repeat(40)), torrentFile('Members', { tracker: 'https://members.example/key/announce', flag: 2 }))
kept.set(torrentKey('d'.repeat(40)), torrentFile('Open', { tracker: 'https://open.example/announce', flag: 0 }))

const ROWS = { a: row('a', 'Kept'), b: row('b', 'Magnet'), p: row('c', 'Members'), z: row('d', 'Open') }

const reads: (ShareableMagnets | null)[] = []
const Probe = ({ rows }: { rows: Torrent[] }) => { reads.push(useShareableMagnets(rows)); return null }
const late: (ShareableMagnets | null)[] = []
const Late = ({ rows }: { rows: Torrent[] }) => { late.push(useShareableMagnets(rows)); return null }

describe('the magnets of the ticked rows', () => {
  it('are read before any copy, in the rows\' order, each as it is shared, and a private one left out', async () => {
    reads.length = 0
    const screen = await render(<Probe rows={[ROWS.z, ROWS.p, ROWS.b, ROWS.a]}/>)
    expect(reads[0], 'nothing to copy while they are read').toBeNull()
    await expect.poll(() => reads.at(-1)).not.toBeNull()
    const { magnets, left } = reads.at(-1)!
    expect(left).toBe(1)
    expect(magnets.map((magnet) => magnetParam(magnet, 'dn') ?? magnet)).toEqual(['Open', ROWS.b.magnet, 'Kept'])
    expect(magnetParams(magnets[2]!, 'tr'), 'from the file this device kept').toEqual(['https://tracker.example/announce'])

    const before = reads.length
    await screen.rerender(<Probe rows={[ROWS.a]}/>)
    expect(reads[before], 'another set of rows has nothing to copy until it is read').toBeNull()
    await expect.poll(() => reads.at(-1)?.magnets.length).toBe(1)
    expect(reads.at(-1)!.left).toBe(0)
  })

  it('are read once for the page, however the ticks change, until a torrent is added again', async () => {
    const again = row('e', 'Again')
    kept.set(torrentKey(again.infoHash!), torrentFile('Again', { tracker: 'https://again.example/announce' }))
    const other = row('f', 'Other')
    reads.length = 0
    asked.length = 0
    const screen = await render(<Probe rows={[again, other]}/>)
    await expect.poll(() => reads.at(-1)?.magnets.length).toBe(2)
    const once = asked.length
    await screen.rerender(<Probe rows={[again]}/>)
    await expect.poll(() => reads.at(-1)?.magnets.length).toBe(1)
    await screen.rerender(<Probe rows={[other, again]}/>)
    await expect.poll(() => reads.at(-1)?.magnets.length).toBe(2)
    expect(asked, 'nothing read again').toHaveLength(once)

    await screen.rerender(<Probe rows={[{ ...again, addedAt: 2 }]}/>)
    await expect.poll(() => reads.at(-1)?.magnets.length).toBe(1)
    expect(asked.length, 'a torrent removed and added again may have another file').toBeGreaterThan(once)
  })

  it('keep the newer ticks\' magnets when an older read answers after them', async () => {
    const slow = row('7', 'Slow')
    const quick = row('8', 'Quick')
    let letGo = () => {}
    held.set(torrentKey(slow.infoHash!), new Promise<void>((resolve) => { letGo = resolve }))
    reads.length = 0
    late.length = 0
    const Both = ({ rows, also }: { rows: Torrent[], also?: Torrent[] }) => <><Probe rows={rows}/>{also && <Late rows={also}/>}</>
    const screen = await render(<Both rows={[slow]}/>)
    await screen.rerender(<Both rows={[quick]}/>)
    await expect.poll(() => reads.at(-1)?.magnets).toEqual([quick.magnet])
    // the same read again, which answers right after the older one does
    await screen.rerender(<Both rows={[quick]} also={[slow]}/>)
    letGo()
    await expect.poll(() => late.at(-1)?.magnets).toEqual([slow.magnet])
    expect(reads.at(-1)?.magnets, 'the older read changed nothing').toEqual([quick.magnet])
  })

  it('leave nothing to copy when every one is private', async () => {
    reads.length = 0
    await render(<Probe rows={[ROWS.p]}/>)
    await expect.poll(() => reads.at(-1)?.left).toBe(1)
    expect(reads.at(-1)!.magnets).toEqual([])
  })
})
