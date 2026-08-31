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
