import { createHash } from 'node:crypto'

import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { buildGroupLink, GROUP_LINK_PREFIX, type LinkedGroup, MAX_LINK_TORRENTS, readGroupLink } from '../../src/router/group-link'
import { DICTIONARY, fromBase64Url, hexDecode, toBase64Url } from '../../src/router/magnet-codec'
import { hexInfoHash, magnetInfoHash } from '../../src/torrent/magnet'
import { REFERENCE_CASES } from '../../src/torrent/reference-torrents'
import { readTorrentFile } from '../../src/torrent/torrent-file'
import THOUSAND_LINK from './group-link-1000.txt?raw'

const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10'
const BUNNY = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
const STEEL = '209c8226b299b308beaf2b9cd3fb49212dbd13ec'
const STEEL_BASE32 = 'ECOIEJVSTGZQRPVPFOONH62JEEW32E7M'
const V2_A = 'caf1e1ab8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5'
const V2_B = '5b4a3928170605f4e3d2c1b0a9f8e7d6c5b4a3928170605f4e3d2c1b0a9f8e7d'
const OPENTRACKR = 'udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
const STEALTH = 'udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce'
const PASSKEY = 'https%3A%2F%2Ftracker.example.org%2Fannounce.php%3Fpasskey%3D0f9e8d7c'

const fragment = (link: string | null) => {
  expect(link?.startsWith(GROUP_LINK_PREFIX), `not a group link: ${link}`).toBe(true)
  return link!.slice(GROUP_LINK_PREFIX.length)
}
const build = (name: string, magnets: string[]) => buildGroupLink(name, magnets.map((magnet) => ({ magnet })))
const roundTrip = (name: string, magnets: string[]) => readGroupLink(fragment(build(name, magnets).link))
const v1Only = (hash: string) => ({ infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}` })

/** A distinct v1 and v2 hash for each index, as hex, the same on every run. */
const pattern = (i: number, length: number) =>
  Array.from({ length }, (_, j) => ((i * 7 + j * 13) & 0xff).toString(16).padStart(2, '0')).join('')
const v1Of = (i: number) => i.toString(16).padStart(4, '0') + pattern(i, 18)
const v2Of = (i: number) => 'ff' + i.toString(16).padStart(4, '0') + pattern(i, 29)

/*
 * Links as they were written. A link pasted in a chat is read for good, so this list only grows: each entry stays,
 * and must keep reading as it says, whatever changes in the code. If one fails, the change broke links people hold.
 */
const WRITTEN: { title: string, name: string, magnets: string[], link: string, group: LinkedGroup }[] = [
  {
    title: 'one v1 torrent',
    name: 'Orbital Gardeners',
    magnets: [`magnet:?xt=urn:btih:${SINTEL}&dn=Sintel&tr=${OPENTRACKR}&tr=${STEALTH}`],
    link: 'https://torrent.fkn.app/add#AQEUCK2lp6YYOq4eCdgx32dI1WYJWhBj9C8C-jcxR8E9sSglNS-1qJiLskRKbF7gAgA',
    group: {
      name: 'Orbital Gardeners',
      torrents: [{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=${OPENTRACKR}&tr=${STEALTH}` }],
    },
  },
  {
    title: 'a v2 torrent',
    name: 'Version two',
    magnets: [`magnet:?xt=urn:btmh:1220${V2_A}&dn=V2.Release&tr=${OPENTRACKR}`],
    link: 'https://torrent.fkn.app/add#AQEgyvHhq4obLD1OX2BxgpOktcbX6PkKGyw9Tl9gcYKTpLVjCkstKs7Mz1MoKc_nIjN5cgEA',
    group: { name: 'Version two', torrents: [{ infoHash: V2_A, magnet: `magnet:?xt=urn:btmh:1220${V2_A}&tr=${OPENTRACKR}` }] },
  },
  {
    title: 'a hybrid torrent',
    name: 'Hybrid',
    magnets: [`magnet:?xt=urn:btih:${BUNNY}&xt=urn:btmh:1220${V2_B}&dn=Hybrid&tr=${OPENTRACKR}`],
    link: 'https://torrent.fkn.app/add#AQE03YJV7Nx8pV-wu_gTI9hwYtsfbRxbSjkoFwYF9OPSwbCp-OfWxbSjkoFwYF9OPSwbCp-OfWP2qEwqykzhIjNlcgEA',
    group: {
      name: 'Hybrid',
      torrents: [{ infoHash: BUNNY, magnet: `magnet:?xt=urn:btih:${BUNNY}&xt=urn:btmh:1220${V2_B}&tr=${OPENTRACKR}` }],
    },
  },
  {
    title: 'a hash in every spelling a magnet may use',
    name: 'Spellings',
    magnets: [
      `magnet:?xt=urn:btih:${STEEL_BASE32}&dn=Base32&tr=${OPENTRACKR}`,
      `magnet:?xt=urn:btih:${SINTEL.toUpperCase()}&dn=Upper`,
      `magnet:?xt=urn%3Abtih%3A${BUNNY}`,
      `magnet:?XT.1=urn:btmh:1220${V2_A.toUpperCase()}&tr=${STEALTH}`,
    ],
    link: 'https://torrent.fkn.app/add#AQRcCK2lp6YYOq4eCdgx32dI1WYJWhDdglXs3HylX7C7-BMj2HBi2x9tHMrx4auKGyw9Tl9gcYKTpLXG1-j5ChssPU5fYHGCk6S1IJyCJrKZswi-ryuc0_tJIS29E-xjZGRiDC5IzcnJzEsv5uLiIi1BoysnNkFzAQA',
    group: {
      name: 'Spellings',
      torrents: [
        v1Only(SINTEL),
        v1Only(BUNNY),
        { infoHash: V2_A, magnet: `magnet:?xt=urn:btmh:1220${V2_A}&tr=${STEALTH}` },
        { infoHash: STEEL, magnet: `magnet:?xt=urn:btih:${STEEL}&tr=${OPENTRACKR}` },
      ],
    },
  },
  {
    title: 'a group name in any script, with a line break',
    name: '映画の題名\nSaison 1 · été 🎬',
    magnets: [`magnet:?xt=urn:btih:${SINTEL}`],
    link: 'https://torrent.fkn.app/add#AQEUCK2lp6YYOq4eCdgx32dI1WYJWhBjfDZjwfMpux83rnu5sOfphF6F4MTM4vw8BUOFQ9sVDq8sObxS4cP8vjVcXAA',
    group: { name: '映画の題名 Saison 1 · été 🎬', torrents: [v1Only(SINTEL)] },
  },
  {
    title: 'every other parameter as written, and a torrent with none',
    name: 'Parameters',
    magnets: [
      `magnet:?xt=urn:btih:${SINTEL}&dn=Sintel&tr=${OPENTRACKR}&tr=${OPENTRACKR}&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&so=0-2,5&x.pe=192.0.2.5:6881&TR=udp://open.stealth.si:80/announce&x.custom=a+b%20c`,
      `magnet:?xt=urn:btih:${BUNNY}`,
      `magnet:?xt=urn:btih:${STEEL}&tr=${PASSKEY}`,
    ],
    link: 'https://torrent.fkn.app/add#AQM83YJV7Nx8pV-wu_gTI9hwYtsfbRwgnIImspmzCL6vK5zT-0khLb0T7AitpaemGDquHgnYMd9nSNVmCVoQY2RkDEgsSsxNLUktKubigjoEsyxLrUjMLciBFAiIhKlXkAFMzW4FicXF2amVqsYuBmmWqRYp5skggyhI6aTrA1YLqA5HSq_AkhVoEoRTDGSqFefbGuga6ZiqVegVpNoaWhrpGegZ6ZlamVlYGKqFBBERxhV6yaXFJfm5tonaSapGBslcAA',
    group: {
      name: 'Parameters',
      torrents: [
        v1Only(BUNNY),
        { infoHash: STEEL, magnet: `magnet:?xt=urn:btih:${STEEL}&tr=${PASSKEY}` },
        {
          infoHash: SINTEL,
          magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=${OPENTRACKR}&tr=${OPENTRACKR}&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&so=0-2,5&x.pe=192.0.2.5:6881&TR=udp://open.stealth.si:80/announce&x.custom=a+b%20c`,
        },
      ],
    },
  },
]

/** The group in group-link-1000.txt: of each ten torrents, the first is hybrid, the sixth v2 only, the rest v1 only. */
const THOUSAND_LISTS = [`&tr=${OPENTRACKR}&tr=${STEALTH}`, '&tr=udp%3A%2F%2Ftracker.example-one.org%3A1337%2Fannounce', '']
const thousand = Array.from({ length: 1000 }, (_, i) => {
  const xt = [i % 10 !== 5 && `xt=urn:btih:${v1Of(i)}`, i % 5 === 0 && `xt=urn:btmh:1220${v2Of(i)}`].filter(Boolean).join('&')
  return {
    sent: `magnet:?${xt}&dn=Item%20${i}${THOUSAND_LISTS[i % 3]}`,
    read: { infoHash: i % 10 === 5 ? v2Of(i) : v1Of(i), magnet: `magnet:?${xt}${THOUSAND_LISTS[i % 3]}` },
  }
})
const byHash = (torrents: { infoHash: string }[]) => [...torrents].sort((a, b) => (a.infoHash < b.infoHash ? -1 : 1))

describe('links already written', () => {
  it('reads them with the dictionary version 1 names, unchanged byte for byte', () => {
    expect(createHash('sha256').update(DICTIONARY).digest('hex')).toBe('1ea72cf2e71fce8f812f300c830cb54c0ca1e202edbe638e50280e9fe435dc7c')
  })

  for (const { title, link, group } of WRITTEN) {
    it(`still reads ${title}`, () => {
      expect(readGroupLink(fragment(link))).toEqual(group)
    })
  }

  it('still reads a thousand torrents of every kind, whose header numbers take two and three bytes', () => {
    // the version, then 1,000 in two bytes and 24,400 hash bytes in three
    expect([...fromBase64Url(fragment(THOUSAND_LINK.trim())).subarray(0, 6)]).toEqual([1, 0xe8, 0x07, 0xd0, 0xbe, 0x01])
    const read = readGroupLink(fragment(THOUSAND_LINK.trim()))
    expect(read?.name).toBe('A thousand')
    expect(byHash(read!.torrents)).toEqual(byHash(thousand.map((t) => t.read)))
  })
})

/*
 * What today's code writes for those groups. Unlike the list above, these bytes may change when fflate is upgraded,
 * since deflate output is not fixed across versions. Then add each new link to WRITTEN as an entry of its own and point
 * this test at it, keeping every old entry.
 */
describe('what a group is built into today', () => {
  for (const { title, name, magnets, link, group } of WRITTEN) {
    it(`builds ${title}`, () => {
      expect(build(name, magnets)).toEqual({ link, count: group.torrents.length, privateLeftOut: 0 })
    })
  }

  it('builds the thousand', () => {
    expect(build('A thousand', thousand.map((t) => t.sent))).toEqual({ link: THOUSAND_LINK.trim(), count: 1000, privateLeftOut: 0 })
  })
})

const varint = (n: number) => {
  const out: number[] = []
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80)
  return [...out, n]
}

type Crafted = { torrents?: { v1?: string, v2?: string }[], name?: string, lines?: string[], kinds?: number[], head?: number[], body?: Uint8Array, version?: number }

/** A record written by hand, field by field, so each refusal below changes one thing and nothing else. */
const craft = ({ torrents = [{ v1: SINTEL }], name = 'Crafted', lines, kinds, head, body, version = 1 }: Crafted = {}) => {
  const hashes = torrents.flatMap((t) => [t.v1, t.v2].filter((h) => h !== undefined)).map(hexDecode)
  const hashBytes = hashes.reduce((total, h) => total + h.length, 0)
  const kindText = (kinds ?? torrents.map((t) => (t.v1 ? 1 : 0) | (t.v2 ? 2 : 0))).map((k) => String.fromCharCode(k)).join('')
  const text = kindText + name + '\n' + (lines ?? torrents.map(() => '')).map((l) => l + '\n').join('')
  const record = [
    ...(head ?? [version, ...varint(torrents.length), ...varint(hashBytes)]),
    ...hashes.flatMap((h) => [...h]),
    ...deflateSync(body ?? new TextEncoder().encode(text), { level: 9, dictionary: DICTIONARY }),
  ]
  return toBase64Url(new Uint8Array(record))
}
const crafted = (torrents: { infoHash: string, magnet: string }[], name = 'Crafted'): LinkedGroup => ({ name, torrents })
const many = (count: number) => Array.from({ length: count }, (_, i) => ({ v1: v1Of(i) }))

describe('refusing a link, each case beside a control that reads', () => {
  it('reads the record the cases below each change once', () => {
    expect(readGroupLink(craft())).toEqual(crafted([v1Only(SINTEL)]))
  })

  it('refuses a link cut short, so a chat app that cuts one never yields part of a group', () => {
    const mixed = Array.from({ length: 250 }, (_, i) => `magnet:?xt=urn:btih:${v1Of(i)}${THOUSAND_LISTS[i % 3]}`)
    const links = [...WRITTEN.map((w) => w.link), THOUSAND_LINK.trim(), build('Mixed', mixed).link]
    for (const link of links) {
      const whole = fragment(link)
      expect(readGroupLink(whole)).not.toBeNull()
      // every cut of up to 1,000 characters off the end, and one length in 97 below that
      const read: number[] = []
      for (let length = 0; length < whole.length; length += length < whole.length - 1000 ? 97 : 1) {
        if (readGroupLink(whole.slice(0, length))) read.push(length)
      }
      expect(read, `cut lengths that read, of ${whole.length}`).toEqual([])
    }
  }, 60_000)

  it('refuses any character outside base64url', () => {
    const whole = fragment(WRITTEN[0]!.link)
    expect(readGroupLink(whole)).not.toBeNull()
    for (const bad of [whole + '=', whole + '==', whole + '.', whole + '…', ' ' + whole, whole.slice(0, 9) + '\n' + whole.slice(9), WRITTEN[0]!.link, '']) {
      expect(readGroupLink(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refuses a version it does not know', () => {
    expect(readGroupLink(craft({ version: 0 }))).toBeNull()
    expect(readGroupLink(craft({ version: 2 }))).toBeNull()
  })

  it('refuses a count of 0 or past the cap, and reads the cap', () => {
    expect(readGroupLink(craft({ torrents: [], name: 'Nothing' }))).toBeNull()
    expect(readGroupLink(craft({ torrents: many(MAX_LINK_TORRENTS + 1) }))).toBeNull()
    expect(readGroupLink(craft({ torrents: many(MAX_LINK_TORRENTS) }))?.torrents).toHaveLength(MAX_LINK_TORRENTS)
  })

  it('refuses a varint written longer than it needs, or past 4 bytes', () => {
    expect(readGroupLink(craft({ head: [1, 0x81, 0x00, 20] }))).toBeNull()
    expect(readGroupLink(craft({ head: [1, 1, 0x94, 0x00] }))).toBeNull()
    expect(readGroupLink(craft({ head: [1, 1, 20] }))).toEqual(crafted([v1Only(SINTEL)]))
    // 8 written in 6 bytes: a reader with no length limit shifts the last byte past 32 bits, where it wraps back to 8
    const eight = many(8)
    expect(readGroupLink(craft({ torrents: eight, head: [1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, ...varint(160)] }))).toBeNull()
    expect(readGroupLink(craft({ torrents: eight, head: [1, 8, ...varint(160)] }))?.torrents).toHaveLength(8)
  })

  it('refuses kinds that are not 1, 2 or 3, or do not name the hashes there are', () => {
    for (const kind of [0, 4, 5, 7, 0x41]) expect(readGroupLink(craft({ kinds: [kind] })), `kind ${kind}`).toBeNull()
    expect(readGroupLink(craft({ kinds: [3] }))).toBeNull()
    expect(readGroupLink(craft({ torrents: [{ v1: BUNNY, v2: V2_A }], kinds: [1] }))).toBeNull()
    expect(readGroupLink(craft({ torrents: [{ v1: BUNNY, v2: V2_A }] }))).toEqual(crafted([
      { infoHash: BUNNY, magnet: `magnet:?xt=urn:btih:${BUNNY}&xt=urn:btmh:1220${V2_A}` },
    ]))
  })

  it('refuses a record that ends inside its hashes', () => {
    expect(readGroupLink(toBase64Url(new Uint8Array([1, 1, 20, ...hexDecode(SINTEL).subarray(0, 10)])))).toBeNull()
    expect(readGroupLink(toBase64Url(new Uint8Array([1, 1, 20, ...hexDecode(SINTEL)])))).toBeNull()
  })

  it('refuses a body inflating past 4 MiB, and reads one of exactly 4 MiB', () => {
    // one kind byte, `Big`, a line feed, then the line and its line feed
    const line = (length: number) => 'a=' + 'b'.repeat(length - 2)
    const room = 4 * 1024 * 1024 - 6
    expect(readGroupLink(craft({ name: 'Big', lines: [line(room)] }))?.torrents[0]?.magnet).toHaveLength(`magnet:?xt=urn:btih:${SINTEL}&`.length + room)
    expect(readGroupLink(craft({ name: 'Big', lines: [line(room + 1)] }))).toBeNull()
  })

  it('refuses a hash written twice, in two torrents or as the v2 hash of two', () => {
    expect(readGroupLink(craft({ torrents: [{ v1: SINTEL }, { v1: SINTEL }] }))).toBeNull()
    expect(readGroupLink(craft({ torrents: [{ v1: BUNNY, v2: V2_A }, { v2: V2_A }] }))).toBeNull()
    expect(readGroupLink(craft({ torrents: [{ v1: BUNNY, v2: V2_A }, { v2: V2_B }] }))?.torrents).toHaveLength(2)
  })

  it('refuses a body that is not UTF-8, or starts with a byte order mark', () => {
    const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)))
    expect(readGroupLink(craft({ body: bytes([1], [0xc3, 0x28], '\n\n') }))).toBeNull()
    expect(readGroupLink(craft({ body: bytes([0xef, 0xbb, 0xbf], [1], 'Crafted\n\n') }))).toBeNull()
    expect(readGroupLink(craft({ body: bytes([1], [0xc3, 0xa9], '\n\n') }))).toEqual(crafted([v1Only(SINTEL)], 'é'))
  })

  it('refuses a group name empty once trimmed', () => {
    expect(readGroupLink(craft({ name: '' }))).toBeNull()
    expect(readGroupLink(craft({ name: ' \t　' }))).toBeNull()
    expect(readGroupLink(craft({ name: ' a ' }))).toEqual(crafted([v1Only(SINTEL)], ' a '))
  })

  it('refuses a line holding anything but 0x21 to 0x7E', () => {
    for (const line of ['tr=a b', 'tr=a\tb', 'tr=é', 'tr=a\x7f', 'tr=\x00', 'tr=a\rb']) {
      expect(readGroupLink(craft({ lines: [line] })), JSON.stringify(line)).toBeNull()
    }
    expect(readGroupLink(craft({ lines: ['tr=a%20b!~'] }))).toEqual(crafted([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=a%20b!~` }]))
  })

  it('refuses a line naming a torrent the way libtorrent reads xt and dn, and reads every other name', () => {
    const refused = [
      `xt=urn:btih:${BUNNY}`, `xt.1=urn:btih:${BUNNY}`, `XT=urn:btih:${BUNNY}`, `xt.=urn:btih:${BUNNY}`, `Xt.07=urn:btih:${BUNNY}`,
      `xt=urn%3Abtih%3A${BUNNY}`, 'dn=Other', 'dn.2=Other', 'DN=Other', 'tr=a&xt=x', 'xt', 'dn',
    ]
    for (const line of refused) expect(readGroupLink(craft({ lines: [line] })), line).toBeNull()
    for (const line of ['xt2=a', 'x.t=a', 'xt.a=a', '.xt=a', 'dnx=a', 'xtx.1=a', 'tr=a&so=1&&x']) {
      expect(readGroupLink(craft({ lines: [line] })), line).toEqual(crafted([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&${line}` }]))
    }
  })

  it('refuses a body with a line more or a line less, or bytes after its last line feed', () => {
    const body = (text: string) => craft({ body: new TextEncoder().encode('\x01' + text) })
    expect(readGroupLink(body('Crafted\n\n'))).toEqual(crafted([v1Only(SINTEL)]))
    for (const text of ['Crafted\n\n\n', 'Crafted\n', 'Crafted\n\nx', 'Crafted\n\nx\n', 'Crafted']) {
      expect(readGroupLink(body(text)), JSON.stringify(text)).toBeNull()
    }
  })
})

describe('building a link', () => {
  it('leaves private torrents out and counts them', () => {
    const torrents = [
      { magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=${PASSKEY}`, private: true },
      { magnet: `magnet:?xt=urn:btih:${BUNNY}` },
      { magnet: `magnet:?xt=urn:btih:${STEEL}&tr=${PASSKEY}`, private: true },
    ]
    const built = buildGroupLink('Mine', torrents)
    expect(built).toMatchObject({ count: 1, privateLeftOut: 2 })
    expect(readGroupLink(fragment(built.link))?.torrents).toEqual([v1Only(BUNNY)])
    expect(buildGroupLink('Mine', torrents.map(({ magnet }) => ({ magnet })))).toMatchObject({ count: 3, privateLeftOut: 0 })
    expect(buildGroupLink('Mine', torrents.filter((t) => t.private))).toEqual({ link: null, count: 0, privateLeftOut: 2 })
  })

  it('leaves out a magnet naming two torrents of one kind, and carries one hash written twice once', () => {
    expect(build('Two', [`magnet:?xt=urn:btih:${SINTEL}&xt.1=urn:btih:${BUNNY}`])).toEqual({ link: null, count: 0, privateLeftOut: 0 })
    expect(build('Two', [`magnet:?xt=urn:btmh:1220${V2_A}&XT=urn:btmh:1220${V2_B}`])).toEqual({ link: null, count: 0, privateLeftOut: 0 })
    expect(roundTrip('One', [`magnet:?xt=urn:btih:${STEEL}&xt.2=urn:btih:${STEEL_BASE32}`])?.torrents).toEqual([v1Only(STEEL)])
    expect(roundTrip('One', [`magnet:?xt=urn:btmh:1220${V2_A}&xt.2=urn:btmh:1220${V2_A.toUpperCase()}`])?.torrents)
      .toEqual([{ infoHash: V2_A, magnet: `magnet:?xt=urn:btmh:1220${V2_A}` }])
  })

  it('takes xt and dn under every name libtorrent reads them by', () => {
    expect(roundTrip('Names', [`magnet:?Dn.3=Name&tr=a&XT.1=urn:btih:${SINTEL}&dn=Other`])?.torrents)
      .toEqual([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=a` }])
  })

  it('hides a part with no = and the part after it, as libtorrent and the library both do', () => {
    const magnet = `magnet:?xt=urn:btih:${SINTEL}&junk&xt=urn:btih:${BUNNY}&tr=a`
    expect(magnetInfoHash(magnet)).toBe(SINTEL)
    expect(roundTrip('Hidden', [magnet])?.torrents).toEqual([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=a` }])
  })

  it('leaves out a magnet libtorrent refuses, and drops an xt of a kind it ignores', () => {
    const refused = [
      `magnet:?xt=urn:btih:${SINTEL}0`, `magnet:?xt=urn:btih:${SINTEL}&xt=urn:btih:${SINTEL}0`, `magnet:?xt=urn:btih:${SINTEL}&xt=urn:btmh:1221${V2_A}`,
      `magnet:?xt=urn:btih:${SINTEL}&xt=urn%ZZ`, 'magnet:?dn=x', `https://example.org/?a=1&xt=urn:btih:${SINTEL}`, 'not a link',
    ]
    for (const magnet of refused) {
      expect(build('Bad', [magnet]), magnet).toEqual({ link: null, count: 0, privateLeftOut: 0 })
    }
    expect(roundTrip('Kept', [`magnet:?xt=urn:sha1:YNCKHTQCWBTRNJIV4WNAE52SJUQCZO5C&xt=urn:btih:${SINTEL}`])?.torrents).toEqual([v1Only(SINTEL)])
  })

  it('reads a pasted magnet as the address bar would, without its tabs and line breaks', () => {
    expect(roundTrip('Pasted', [`magnet:?xt=urn:btih:${SINTEL}&tr=udp://a.example:1/announce\n\t&tr=b c&x=é`])?.torrents)
      .toEqual([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=udp://a.example:1/announce&tr=b%20c&x=%C3%A9` }])
  })

  it('carries a torrent once, however often and in whichever form it is named', () => {
    expect(roundTrip('Twice', [`magnet:?xt=urn:btih:${SINTEL}&tr=a`, `magnet:?xt=urn:btih:${SINTEL}&tr=b`])?.torrents)
      .toEqual([{ infoHash: SINTEL, magnet: `magnet:?xt=urn:btih:${SINTEL}&tr=a` }])
    expect(build('Twins', [`magnet:?xt=urn:btih:${BUNNY}&xt=urn:btmh:1220${V2_A}`, `magnet:?xt=urn:btmh:1220${V2_A}`])).toMatchObject({ count: 1 })
    expect(build('Cases', [`magnet:?xt=urn:btmh:1220${V2_A}`, `magnet:?xt=urn:btmh:1220${V2_A.toUpperCase()}`])).toMatchObject({ count: 1 })
  })

  it('holds up to MAX_LINK_TORRENTS torrents, and builds nothing past them', () => {
    const magnets = Array.from({ length: MAX_LINK_TORRENTS + 1 }, (_, i) => `magnet:?xt=urn:btih:${v1Of(i)}`)
    expect(roundTrip('Full', magnets.slice(0, MAX_LINK_TORRENTS))?.torrents).toHaveLength(MAX_LINK_TORRENTS)
    expect(build('Over', magnets)).toEqual({ link: null, count: MAX_LINK_TORRENTS + 1, privateLeftOut: 0 })
  })

  it('builds no link for a group name empty once trimmed', () => {
    expect(build(' \n\t ', [`magnet:?xt=urn:btih:${SINTEL}`])).toEqual({ link: null, count: 1, privateLeftOut: 0 })
  })

  it('builds the same link for the same torrents in any order', () => {
    const magnets = Array.from({ length: 25 }, (_, i) => `magnet:?xt=urn:btih:${v1Of(i)}${THOUSAND_LISTS[i % 3]}`)
    const link = build('Order', magnets).link
    expect(build('Order', [...magnets].reverse()).link).toBe(link)
    expect(build('Order', [...magnets.slice(13), ...magnets.slice(0, 13)]).link).toBe(link)
  })

  it('gives each torrent of a generated group back as it was sent, from 1 to 1,000 torrents', () => {
    let seed = 7
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!
    const trackers = [[OPENTRACKR, STEALTH], [STEALTH], ['wss%3A%2F%2Ftracker.btorrent.xyz', 'udp%3A%2F%2Fexplodie.org%3A6969'], [PASSKEY], []]
    let next = 0
    for (const size of [1, 2, 10, 100, 250, 1000]) {
      const torrents = Array.from({ length: size }, () => {
        const i = next++
        const kind = random()
        const xt = [kind < 0.9 && `xt=urn:btih:${v1Of(i)}`, kind > 0.8 && `xt=urn:btmh:1220${v2Of(i)}`].filter(Boolean)
        const others = [
          ...pick(trackers).map((t) => `tr=${t}`),
          ...(random() < 0.2 ? ['ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'] : []),
          ...(random() < 0.1 ? ['so=0-2,5'] : []),
        ]
        return {
          sent: `magnet:?${[...xt, `dn=Torrent%20${i}`, ...others].join('&')}`,
          read: { infoHash: kind < 0.9 ? v1Of(i) : v2Of(i), magnet: `magnet:?${[...xt, ...others].join('&')}` },
        }
      })
      const read = roundTrip(`Size ${size}`, torrents.map((t) => t.sent))
      expect(read?.name).toBe(`Size ${size}`)
      expect(byHash(read!.torrents)).toEqual(byHash(torrents.map((t) => t.read)))
      for (const t of read!.torrents) expect(magnetInfoHash(t.magnet)).toBe(t.infoHash)
    }
  })

  it('gives the 36 reference torrents back under the info hash the sender keys them by', async () => {
    const magnets: string[] = []
    for (const reference of REFERENCE_CASES) {
      for (const encoded of Object.values(reference.torrents)) {
        const subject = await readTorrentFile(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))
        magnets.push(subject!.magnet)
      }
    }
    const read = roundTrip('Reference', magnets)
    expect(read?.torrents).toHaveLength(36)
    const keys = magnets.map((m) => hexInfoHash(magnetInfoHash(m)!)).sort()
    expect(read!.torrents.map((t) => t.infoHash).sort()).toEqual(keys)
    for (const t of read!.torrents) expect(magnetInfoHash(t.magnet)).toBe(t.infoHash)
    expect(keys.filter((k) => k.length === 64), 'the v2-only ones').toHaveLength(12)
  })
})
