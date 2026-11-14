import { describe, expect, it } from 'vitest'

import { TORRENT_ID_PATTERN } from '../../src/torrent/opfs-sweep'
import { magnetInfoHash, magnetParam } from '../../src/torrent/magnet'

const V1 = '08ada5a7a6183aae1e09d831df6748d566095a10'
const V2 = 'caf1e1c30e81cb361b9ee167c4aa64228a7fa4fa9f6105232b28ad099f3a302e'

describe('which torrent a magnet names', () => {
  it('reads a plain v1 magnet', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${V1}&dn=Sintel`)).toBe(V1)
  })

  it('lowercases, since a magnet is routinely pasted in upper case', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${V1.toUpperCase()}`)).toBe(V1)
  })

  it('keeps a base32 infohash as it is, which is also legal', () => {
    expect(magnetInfoHash('magnet:?xt=urn:btih:BCWSLJ5GDA5K4HQJ3AY57Z2I2VTASWQQ'))
      .toBe('bcwslj5gda5k4hqj3ay57z2i2vtaswqq')
  })

  /**
   * The multihash prefix is part of the urn and not part of the id. Keeping it produced a
   * 68-character string that matched neither of the lengths the orphan sweep recognises, so the
   * torrent's whole save directory was removed about a minute after the page loaded.
   */
  it('strips the 1220 multihash prefix off a v2 magnet', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btmh:1220${V2}&dn=V2.Release`)).toBe(V2)
    expect(magnetInfoHash(`magnet:?xt=urn:btmh:1220${V2}`)!.length).toBe(64)
  })

  /** The control that makes the one above mean something: the sweep has to accept what comes out. */
  it('answers an id the orphan sweep recognises, for every kind of magnet', () => {
    for (const magnet of [
      `magnet:?xt=urn:btih:${V1}`,
      `magnet:?xt=urn:btmh:1220${V2}`,
      `magnet:?xt=urn:btih:${V1}&xt=urn:btmh:1220${V2}`,
      'magnet:?xt=urn:btih:BCWSLJ5GDA5K4HQJ3AY57Z2I2VTASWQQ',
    ]) {
      expect(TORRENT_ID_PATTERN.test(magnetInfoHash(magnet)!)).toBe(true)
    }
    /*
     * The control, and it is the whole point of the assertion above. Both of these were real ids
     * Ripple produced, both matched nothing, and an id the sweep does not recognise has its save
     * directory deleted about a minute after the page loads while the library still lists it.
     */
    expect(TORRENT_ID_PATTERN.test(`1220${V2}`)).toBe(false)
    expect(TORRENT_ID_PATTERN.test('not an infohash at all')).toBe(false)
  })

  /**
   * A hybrid is ONE torrent with two names, so which one comes back cannot depend on how the link
   * was written. Both orders have to answer with the v1 hash, or the same torrent gets two
   * identities and neither finds the other's data.
   */
  it('answers a hybrid with its v1 hash, whichever xt was written first', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${V1}&xt=urn:btmh:1220${V2}&dn=Hybrid`)).toBe(V1)
    expect(magnetInfoHash(`magnet:?xt=urn:btmh:1220${V2}&xt=urn:btih:${V1}&dn=Hybrid`)).toBe(V1)
  })

  it('answers nothing for a link that names no torrent', () => {
    expect(magnetInfoHash('magnet:?dn=Nothing')).toBeNull()
    expect(magnetInfoHash('https://example.test/file.torrent')).toBeNull()
  })
})

/**
 * libtorrent reads `XT`, `xt.1` and a percent-escaped value as `xt`, and keeps the LAST v1 and the last v2 hash it
 * reads, so a magnet naming two torrents was listed under the first and downloaded as the second.
 */
describe('a magnet that names more than one torrent', () => {
  const A = '1a'.repeat(20)
  const B = '2b'.repeat(20)
  const C = '3c'.repeat(32)
  const D = '4d'.repeat(32)
  // 20 bytes of 0xff, which base32 writes as 32 sevens
  const F = 'ff'.repeat(20)

  it.each([
    ['xt and xt.1', `magnet:?xt=urn:btih:${A}&xt.1=urn:btih:${B}`],
    ['xt twice', `magnet:?xt=urn:btih:${A}&xt=urn:btih:${B}`],
    ['xt and XT', `magnet:?xt=urn:btih:${A}&XT=urn:btih:${B}`],
    ['xt and a percent-escaped xt', `magnet:?xt=urn:btih:${A}&xt=urn%3Abtih%3A${B}`],
    ['two v2 hashes', `magnet:?xt=urn:btmh:1220${C}&xt=urn:btmh:1220${D}`],
    ['a hybrid and a second v1', `magnet:?xt=urn:btih:${A}&xt=urn:btmh:1220${C}&xt.1=urn:btih:${B}`],
    ['a hash and one of the wrong length', `magnet:?xt=urn:btih:${A}&xt.1=urn:btih:${B.slice(0, 39)}`],
  ])('names none when it carries %s', (_name, magnet) => {
    expect(magnetInfoHash(magnet)).toBeNull()
  })

  it('counts no xt inside a tracker address, which the engine reads as part of the tracker', () => {
    expect(magnetInfoHash(`magnet:?tr=http://t.example/a?xt=urn:btih:${B}&xt=urn:btih:${A}`)).toBe(A)
    expect(magnetInfoHash(`magnet:?tr=${encodeURIComponent(`http://t.example/a?xt=urn:btih:${B}`)}&xt=urn:btih:${A}`)).toBe(A)
  })

  it('reads an xt written with a number, as the engine does', () => {
    expect(magnetInfoHash(`magnet:?xt.1=urn:btih:${B}`)).toBe(B)
    expect(magnetInfoHash(`magnet:?xt.2=urn:btih:${B}`)).toBe(B)
    expect(magnetInfoHash(`magnet:?xt.1=urn:btih:${A}&xt.2=urn:btmh:1220${C}`)).toBe(A)
  })

  it('counts one torrent written twice as one, keyed as it is written first', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${F}&xt=urn:btih:${'7'.repeat(32)}`)).toBe(F)
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${'7'.repeat(32)}&xt=urn:btih:${F}`)).toBe('7'.repeat(32))
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${A.toUpperCase()}&xt=urn:btih:${A}`)).toBe(A)
  })

  it('keeps a lone hash of the wrong length as written, for the add dialog to call malformed', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${A.slice(0, 39)}`)).toBe(A.slice(0, 39))
  })

  it('ignores an xt of another network beside the torrent', () => {
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${A}&xt=urn:sha1:${'Q'.repeat(32)}`)).toBe(A)
  })

  /**
   * The engine skips both of these v1 hashes and downloads the v2 one, so reading the v1 listed the magnet under a
   * torrent the engine never fetched.
   */
  it('skips a v1 hash the engine skips, beside a v2 one', () => {
    expect(magnetInfoHash(`magnet:?xt=URN:BTIH:${A}&xt=urn:btmh:1220${D}`)).toBe(D)
    expect(magnetInfoHash(`magnet:?flag&xt=urn:btih:${A}&xt=urn:btmh:1220${D}`)).toBe(D)
    expect(magnetInfoHash(`magnet:?dn=x&&xt=urn:btih:${A}&xt=urn:btmh:1220${D}`)).toBe(D)
    expect(magnetInfoHash(`magnet:?xt=URN:BTIH:${A}`)).toBeNull()
  })
})

describe('reading one parameter back out', () => {
  it('decodes a percent-encoded name', () => {
    expect(magnetParam(`magnet:?xt=urn:btih:${V1}&dn=%E6%98%A0%E7%94%BB`, 'dn')).toBe('映画')
  })

  it('treats a plus as a space, which is how trackers write one', () => {
    expect(magnetParam(`magnet:?xt=urn:btih:${V1}&dn=Big+Buck+Bunny`, 'dn')).toBe('Big Buck Bunny')
  })

  it('answers undefined for a key that is not there', () => {
    expect(magnetParam(`magnet:?xt=urn:btih:${V1}`, 'dn')).toBeUndefined()
  })
})
