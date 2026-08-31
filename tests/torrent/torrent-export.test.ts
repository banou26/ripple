/*
 * The one property that matters: a rebuilt file must be the SAME torrent.
 *
 * The infohash is the SHA-1 of the info dictionary's bytes exactly as they appear, so a rebuild that
 * decodes and re-encodes produces a valid torrent for a DIFFERENT infohash. That fails in the worst
 * way available: the file opens fine in any client, describes the right files at the right sizes, and
 * finds no peers, because it is asking a swarm that does not exist.
 *
 * Proved against the reference torrents, which are bytes native libtorrent wrote.
 */
import { describe, expect, it } from 'vitest'

import { REFERENCE_CASES } from '../../src/torrent/reference-torrents'
import { buildTorrentFile, infoFromResume, magnetExtras } from '../../src/torrent/torrent-export'
import { magnetInfoHash, magnetParams } from '../../src/torrent/magnet'
import { readTorrentFile } from '../../src/torrent/torrent-file'

const bytesOf = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('rebuilding a .torrent from its info dictionary', () => {
  /*
   * `infoFromResume` finds the info value inside any bencoded dictionary carrying one, which a
   * .torrent is as much as a resume blob, so the reference files stand in for blobs here and the
   * comparison is against bytes libtorrent itself produced.
   */
  for (const reference of REFERENCE_CASES) {
    for (const format of ['v1', 'hybrid', 'v2'] as const) {
      const source = reference.torrents?.[format]
      if (!source) continue

      it(`keeps the infohash of ${reference.name} (${format})`, async () => {
        const original = bytesOf(source)
        const info = infoFromResume(original)
        expect(info, 'no info dictionary was found, so this test proved nothing').toBeTruthy()

        const rebuilt = buildTorrentFile(info!, { trackers: ['udp://tracker.example:1337'] })

        const before = await readTorrentFile(original)
        const after = await readTorrentFile(rebuilt)
        // the identity lives in the magnet a ShareSubject carries, which is what the app keys on
        const was = magnetInfoHash(before?.magnet ?? '')
        expect(was, 'the fixture did not parse').toBeTruthy()
        expect(magnetInfoHash(after?.magnet ?? '')).toBe(was)
        // and it still describes the same content, not merely the same number
        expect(after?.files?.length).toBe(before?.files?.length)
      })
    }
  }
})

describe('the shape of the file it writes', () => {
  const info = infoFromResume(bytesOf(REFERENCE_CASES[0]!.torrents!.v1!))!

  it('writes a valid torrent when the magnet carried no trackers at all', async () => {
    const rebuilt = buildTorrentFile(info, {})
    expect(text(rebuilt).startsWith('d4:info')).toBe(true)
    expect(magnetInfoHash((await readTorrentFile(rebuilt))?.magnet ?? '')).toBeTruthy()
  })

  it('puts the keys in ASCII order, which a bencoded dictionary is defined to be', () => {
    const rendered = text(buildTorrentFile(info, { trackers: ['udp://a:1'], webSeeds: ['https://b/'] }))
    const order = ['8:announce', '13:announce-list', '4:info', '8:url-list']
      .map((key) => rendered.indexOf(key))
    expect(order.every((at) => at >= 0), 'a key this asserts the order of is missing').toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('carries every tracker, not just the one announce names', () => {
    const rendered = text(buildTorrentFile(info, { trackers: ['udp://a:1', 'udp://b:2', 'udp://c:3'] }))
    for (const tracker of ['udp://a:1', 'udp://b:2', 'udp://c:3']) expect(rendered).toContain(tracker)
    // announce is the first, and the list repeats it rather than omitting it
    expect(rendered.indexOf('udp://a:1')).toBeLessThan(rendered.indexOf('udp://b:2'))
  })

  it('takes the web seeds across, which are what make a torrent work with no peers', () => {
    const rendered = text(buildTorrentFile(info, { webSeeds: ['https://example.test/files/'] }))
    expect(rendered).toContain('8:url-list')
    expect(rendered).toContain('https://example.test/files/')
  })
})

describe('what a magnet contributes', () => {
  const magnet = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
    + '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969'
    + '&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'

  it('reads EVERY tracker, where the single-value reader keeps only the first', () => {
    expect(magnetParams(magnet, 'tr')).toEqual(['udp://tracker.opentrackr.org:1337', 'udp://explodie.org:6969'])
  })

  it('hands the builder both lists, decoded', () => {
    expect(magnetExtras(magnet)).toEqual({
      trackers: ['udp://tracker.opentrackr.org:1337', 'udp://explodie.org:6969'],
      webSeeds: ['https://webtorrent.io/torrents/'],
    })
  })

  it('answers with empty lists for a bare magnet rather than throwing', () => {
    expect(magnetExtras('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10'))
      .toEqual({ trackers: [], webSeeds: [] })
  })
})
