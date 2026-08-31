import { describe, expect, it } from 'vitest'

import { decodeMagnetParam, encodeMagnetParam, packMagnet, unpackMagnet } from '../../src/router/magnet-codec'

/*
 * The corpus is the point of this file.
 *
 * Two earlier versions of this measurement passed while silently losing a field, both times because
 * the check could not express the failure: the first compared only xt/dn/tr, so a dropped `ws=` went
 * unnoticed, and the second fixed that but carried no HYBRID v1+v2 magnet, so an encoder reading
 * `searchParams.get('xt')` dropped the second hash and nothing objected.
 *
 * So every legal magnet shape ripple accepts is listed here, and the round trip is compared on the
 * FULL parameter list including repeated keys. A shape that is not in this list is a shape nothing
 * is checking.
 */
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const HASH_V2 = 'caf1e1ab8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5'
const TRACKER = 'udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'

const CORPUS: [string, string][] = [
  ['a bare hash', `magnet:?xt=urn:btih:${HASH}`],
  ['a hash and a name', `magnet:?xt=urn:btih:${HASH}&dn=Sintel`],
  ['web seeds', `magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=${TRACKER}&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F`],
  ['several trackers', `magnet:?xt=urn:btih:${HASH}&dn=Release&tr=${TRACKER}&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce`],
  ['a tracker nothing knows', `magnet:?xt=urn:btih:${HASH}&dn=Private&tr=https%3A%2F%2Ftr.example.org%3A443%2Fannounce.php%3Fpasskey%3D9f8e7d6c`],
  ['a plus-encoded name', `magnet:?xt=urn:btih:${HASH}&dn=Big+Buck+Bunny&tr=${TRACKER}`],
  ['a percent-encoded unicode name', `magnet:?xt=urn:btih:${HASH}&dn=%E6%98%A0%E7%94%BB%E3%81%AE%E9%A1%8C%E5%90%8D`],
  ['a v2 multihash', `magnet:?xt=urn:btmh:1220${HASH_V2}&dn=V2.Release&tr=${TRACKER}`],
  ['a hybrid v1 and v2', `magnet:?xt=urn:btih:${HASH}&xt=urn:btmh:1220${HASH_V2}&dn=Hybrid&tr=${TRACKER}`],
  ['a base32 infohash', 'magnet:?xt=urn:btih:BCWSLJ5GDA5K4HQJ3AY57Z2I2VTASWQQ&dn=Base32'],
  ['select-only and peer hints', `magnet:?xt=urn:btih:${HASH}&so=0-2,5&x.pe=192.168.1.5%3A6881`],
  ['an uppercase hex hash', `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Upper`],
]

/** Every parameter, in order, decoded, with `xt` case-folded because hex case carries no meaning. */
const fields = (magnet: string) =>
  [...new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1)).entries()]
    .map(([key, value]) => [key, key === 'xt' ? value.toLowerCase() : value])

describe('packing a magnet', () => {
  for (const [name, magnet] of CORPUS) {
    it(`round-trips ${name}`, () => {
      const packed = packMagnet(magnet)
      expect(packed, 'this shape did not pack at all').not.toBeNull()
      const back = unpackMagnet(packed!)
      expect(back).not.toBeNull()
      expect(fields(back!)).toEqual(fields(magnet))
    })
  }

  /*
   * The negative control. Everything above asserts "nothing was lost", and a comparison that cannot
   * see a loss reports that unconditionally. This proves `fields` notices the exact two losses that
   * got past the two earlier versions of this check.
   */
  it('would notice a dropped web seed', () => {
    const magnet = CORPUS.find(([name]) => name === 'web seeds')![1]
    expect(fields(magnet.replace(/&ws=[^&]*/, ''))).not.toEqual(fields(magnet))
  })

  it('would notice a dropped second hash on a hybrid', () => {
    const magnet = CORPUS.find(([name]) => name === 'a hybrid v1 and v2')![1]
    expect(fields(magnet.replace(/&xt=urn:btmh:[0-9a-f]+/, ''))).not.toEqual(fields(magnet))
  })

  it('refuses a magnet carrying no hash it can hold, rather than guessing', () => {
    expect(packMagnet('magnet:?dn=nothing+to+name')).toBeNull()
    expect(packMagnet('magnet:?xt=urn:btih:tooshort&dn=x')).toBeNull()
  })

  it('gives back null for bytes that are not a packed magnet', () => {
    expect(unpackMagnet(new Uint8Array([1, 0, 1, 2, 3]))).toBeNull()
    expect(unpackMagnet(new Uint8Array([0]))).toBeNull()
    expect(unpackMagnet(new Uint8Array())).toBeNull()
  })
})

/**
 * The dictionary is frozen, and until this test existed nothing enforced that: editing TRACKERS
 * rewrote what every link already handed out decodes to, and the whole suite stayed green, because
 * every other test here encodes and decodes with the same edited table.
 *
 * This pins the bytes instead. A link is a promise made to somebody else's clipboard, so the only
 * correct way to change the table is to leave it alone and add a new parameter name beside it.
 * If this fails, that is what it is telling you. Do not update the expected value.
 */
describe('the frozen dictionary', () => {
  it('still produces the exact bytes that links in the wild were written with', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=${TRACKER}`
    expect(encodeMagnetParam(magnet)).toEqual({
      key: 'm',
      value: 'AQAIraWnphg6rh4J2DHfZ0jVZglaEAMWq8GZeSWpOeSmTQA',
    })
  })

  it('decodes a value captured before this test was written, which is the promise it is keeping', () => {
    const captured = 'AQAIraWnphg6rh4J2DHfZ0jVZglaEAMWq8GZeSWpOeSmTQA'
    const back = decodeMagnetParam(new URLSearchParams({ m: captured }))
    expect(back).toBe(`magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=${TRACKER}`)
  })
})

describe('choosing a parameter', () => {
  it('picks the packed form for an ordinary magnet, and it is much shorter', () => {
    const magnet = CORPUS.find(([name]) => name === 'several trackers')![1]
    const encoded = encodeMagnetParam(magnet)!
    expect(encoded.key).toBe('m')
    expect(encoded.value.length).toBeLessThan(btoa(magnet).length / 2)
  })

  /**
   * deflate expands anything under roughly 84 bytes, so the packed form is not unconditionally
   * smaller and the encoder compares rather than assuming. This pins that it never emits the longer
   * of the two, whichever way a future dictionary change tips it.
   */
  for (const [name, magnet] of CORPUS) {
    it(`never emits a longer value than the legacy form for ${name}`, () => {
      const encoded = encodeMagnetParam(magnet)!
      expect(encoded.value.length).toBeLessThanOrEqual(btoa(new URL(magnet).href).length)
    })
  }

  /**
   * The encoder memoises, because it runs per library row inside a render. A cache that returned
   * one torrent's link for another would be the worst bug available here: silently correct-looking,
   * and it would hand somebody the wrong download.
   */
  it('never serves one magnet the answer it computed for another', () => {
    const seen = new Map<string, string>()
    // twice through, so the second pass is entirely cache hits
    for (const pass of [1, 2]) {
      for (const [name, magnet] of CORPUS) {
        const { key, value } = encodeMagnetParam(magnet)!
        const previous = seen.get(name)
        if (previous !== undefined) expect(value, `${name} changed between passes`).toBe(previous)
        seen.set(name, value)
        expect(fields(decodeMagnetParam(new URLSearchParams({ [key]: value }))!), `${name} on pass ${pass}`)
          .toEqual(fields(new URL(magnet).href))
      }
    }
    // and every distinct magnet still has a distinct encoding
    expect(new Set(seen.values()).size).toBe(CORPUS.length)
  })

  it('falls back to the published base64 form when nothing can be packed', () => {
    const encoded = encodeMagnetParam('magnet:?dn=no+hash+here')!
    expect(encoded.key).toBe('magnet')
    expect(atob(encoded.value)).toBe('magnet:?dn=no+hash+here')
  })

  it('gives back null for something no encoding can save', () => {
    expect(encodeMagnetParam('\u{1F600} not a url')).toBeNull()
  })

  it('takes a raw unicode display name, which btoa alone cannot', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=映画の題名`
    expect(() => btoa(magnet)).toThrow()
    const encoded = encodeMagnetParam(magnet)!
    expect(encoded).not.toBeNull()
    const back = decodeMagnetParam(new URLSearchParams({ [encoded.key]: encoded.value }))!
    expect(new URLSearchParams(back.slice(back.indexOf('?') + 1)).get('dn')).toBe('映画の題名')
  })

  it('produces a value a query string carries without escaping, so nothing is spent on percent signs', () => {
    for (const [, magnet] of CORPUS) {
      const { key, value } = encodeMagnetParam(magnet)!
      if (key !== 'm') continue
      expect(value, `${value} would be percent-encoded in a URL`).toMatch(/^[A-Za-z0-9\-_]*$/)
      expect(new URLSearchParams({ m: value }).toString()).toBe(`m=${value}`)
    }
  })
})

describe('reading a parameter back', () => {
  for (const [name, magnet] of CORPUS) {
    it(`survives a full encode and decode for ${name}`, () => {
      const { key, value } = encodeMagnetParam(magnet)!
      const back = decodeMagnetParam(new URLSearchParams({ [key]: value }))!
      expect(fields(back)).toEqual(fields(new URL(magnet).href))
    })
  }

  /**
   * The obligation that outlives every other decision here. README publishes `magnet=<base64>` and
   * the share dialog only ever wrote to a clipboard, so links pasted in chats years ago cannot be
   * found or rewritten. This test is what makes deleting that path a visible act.
   */
  it('still reads a plain base64 link written before any of this existed', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`
    expect(decodeMagnetParam(new URLSearchParams({ magnet: btoa(magnet) }))).toBe(magnet)
  })

  it('prefers the packed parameter when a link somehow carries both', () => {
    const packed = encodeMagnetParam(`magnet:?xt=urn:btih:${HASH}&dn=Packed`)!
    const params = new URLSearchParams({ [packed.key]: packed.value, magnet: btoa(`magnet:?xt=urn:btih:${HASH}&dn=Legacy`) })
    expect(decodeMagnetParam(params)).toContain('dn=Packed')
  })

  it('falls through to the legacy parameter when the packed one is junk', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`
    expect(decodeMagnetParam(new URLSearchParams({ m: '!!!not base64!!!', magnet: btoa(magnet) }))).toBe(magnet)
  })

  it('gives back undefined rather than throwing on anything unreadable', () => {
    expect(decodeMagnetParam(new URLSearchParams())).toBeUndefined()
    expect(decodeMagnetParam(new URLSearchParams({ m: 'AAAAAAAA' }))).toBeUndefined()
    expect(decodeMagnetParam(new URLSearchParams({ m: '' }))).toBeUndefined()
    expect(decodeMagnetParam(new URLSearchParams({ magnet: 'not base64 at all !!' }))).toBeUndefined()
    expect(decodeMagnetParam(new URLSearchParams({ magnet: '' }))).toBeUndefined()
  })

  /*
   * A packed value is embedder-written text that reaches the engine with no validation in between,
   * so the decoder is fed deliberate garbage here. The requirement is only that it never throws:
   * whatever it returns, the caller treats a null as "no link".
   */
  /**
   * The property the previous encoding had for free and this one has to be given.
   *
   * base64 DEFLATES text by 0.75, so a `magnet=` link could never name a magnet longer than the URL
   * carrying it. Deflate inverts that: measured at 1010:1 on a repetitive payload, so a 64KB URL
   * (which the edge serves; it only starts refusing above that) would otherwise produce a ~45MB
   * string, synchronously, during a render, and hand it to the engine.
   */
  it('refuses a value that inflates out of all proportion, rather than handing it on', () => {
    const huge = `magnet:?xt=urn:btih:${HASH}&dn=${'A'.repeat(2_000_000)}`
    const packed = packMagnet(huge)!
    expect(packed, 'the fixture no longer packs, so this test is checking nothing').not.toBeNull()
    // small enough to sit in a URL comfortably, which is the whole problem
    expect(packed.length).toBeLessThan(5_000)
    expect(unpackMagnet(packed)).toBeNull()
  })

  it('still accepts a magnet that is merely large, so the cap is not just a low ceiling', () => {
    const many = `magnet:?xt=urn:btih:${HASH}&dn=Big.Release&` + Array.from({ length: 60 }, (_, i) =>
      `tr=udp%3A%2F%2Ftracker${i}.example.org%3A1337%2Fannounce`).join('&')
    const back = unpackMagnet(packMagnet(many)!)
    expect(back).not.toBeNull()
    expect(fields(back!)).toEqual(fields(many))
  })

  it('never throws on hostile input', () => {
    const hostile = ['A', 'AA', '-', '_'.repeat(100), 'AQ', 'AQID', btoa('magnet:?xt=urn:btih:' + HASH), 'A'.repeat(5000)]
    for (const value of hostile) {
      expect(() => decodeMagnetParam(new URLSearchParams({ m: value })), value.slice(0, 20)).not.toThrow()
    }
  })
})
