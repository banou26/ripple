import { describe, expect, it } from 'vitest'

import { compileFileSelection, embedIframe, embedPath, embedUrl, encodeMagnet } from './embed-link'
import { parseFileSelection, resolveSelection } from './file-selection'

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'

describe('compileFileSelection', () => {
  it('collapses a run into a range', () => {
    expect(compileFileSelection([1, 2, 3], 10)).toBe('1-3')
  })

  it('leaves a lone index alone', () => {
    expect(compileFileSelection([4], 10)).toBe('4')
  })

  it('mixes runs and singles, shortest first', () => {
    expect(compileFileSelection([0, 2, 3, 4, 9], 10)).toBe('0,2-4,9')
  })

  it('sorts and dedupes whatever order the caller checked boxes in', () => {
    expect(compileFileSelection([4, 2, 3, 2, 4], 10)).toBe('2-4')
  })

  it('omits the param when every file is named, because absent already means all', () => {
    expect(compileFileSelection([0, 1, 2], 3)).toBeNull()
  })

  it('drops indices the torrent does not have rather than naming them', () => {
    expect(compileFileSelection([0, 99, -1, 1.5], 3)).toBe('0')
  })

  /**
   * The one case the grammar cannot express, pinned so it stays deliberate.
   *
   * An absent `files` means ALL, so an empty selection compiling to "omit the param" is a widening
   * from nothing to everything. The panel must never reach here with an empty set; it disables its
   * output instead. This test exists so that rule has somewhere to point.
   */
  it('cannot express an empty selection, and says so by returning null', () => {
    expect(compileFileSelection([], 3)).toBeNull()
  })
})

/**
 * The property that matters: whatever the panel writes, the embed page reads back as the same files.
 *
 * These two modules are inverses and nothing else checks that. A change to either grammar that
 * breaks the pairing produces links that silently deliver the wrong episodes, which is exactly the
 * failure the download page's engine-index handling was written to avoid.
 */
describe('compile then parse round trip', () => {
  const CASES: [number[], number][] = [
    [[0], 1],
    [[3], 12],
    [[1, 2, 3], 12],
    [[0, 2, 3, 4, 9], 12],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12],
    [[11], 12],
    [[0, 11], 12],
    [[2, 4, 6, 8], 12],
    [[0, 1, 4, 5, 8, 9], 12],
  ]

  for (const [indices, count] of CASES) {
    it(`survives ${JSON.stringify(indices)} of ${count}`, () => {
      const files = compileFileSelection(indices, count)
      // null is the "omit it" signal, and an omitted files= must mean every file
      const back = resolveSelection(parseFileSelection(files, undefined), count)
      expect(back).toEqual(files === null ? [...Array(count).keys()] : indices)
    })
  }

  it('survives a fuzz of random subsets', () => {
    const count = 24
    // seeded by index rather than Math.random, so a failure here is reproducible
    for (let seed = 1; seed <= 200; seed++) {
      const indices = [...Array(count).keys()].filter((i) => ((i + 1) * seed) % 7 < 3)
      if (!indices.length) continue
      const files = compileFileSelection(indices, count)
      const back = resolveSelection(parseFileSelection(files, undefined), count)
      expect(back, `seed ${seed} -> ${files}`).toEqual(indices.length === count ? [...Array(count).keys()] : indices)
    }
  })
})

describe('embedPath', () => {
  it('carries only the magnet for a plain watch link', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch' })).toBe(`/embed?magnet=${encodeURIComponent(btoa(MAGNET))}`)
  })

  it('names a file on a watch link with fileIndex, which is what the player reads', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 5 })).toContain('fileIndex=5')
  })

  it('leaves fileIndex off when it is 0, because absent already means the first file', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 0 })).not.toContain('fileIndex')
  })

  it('leaves mode off for watch, because absent already means the player', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch' })).not.toContain('mode')
  })

  /**
   * The player never reads `files`, so putting one on a watch link would be quietly ignored and the
   * embed would open whatever the player picked for itself instead of what the panel showed.
   */
  it('never puts a files list on a watch link', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'watch', indices: [1, 2], fileCount: 9, fileIndex: 1 })
    expect(path).not.toContain('files=')
    expect(path).toContain('fileIndex=1')
  })

  it('puts the set on a download link and leaves fileIndex out of it', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', indices: [1, 2], fileCount: 9, fileIndex: 7 })
    expect(path).toContain('mode=download')
    expect(path).toContain('files=1-2')
    expect(path).not.toContain('fileIndex')
  })

  it('omits files when the download names the whole torrent', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', indices: [0, 1, 2], fileCount: 3 })
    expect(path).toContain('mode=download')
    expect(path).not.toContain('files=')
  })

  /**
   * base64 of a magnet can contain `+`, `/` and `=`, and a `+` written literally into a query string
   * reads back as a SPACE, so the magnet fails to decode and the embed shows nothing.
   */
  it('percent-encodes a base64 magnet rather than trusting it in a query string', () => {
    // this exact `dn` is chosen so the base64 contains a '+' AND the magnet is already normalized,
    // so the property under test is the query encoding rather than anything encodeMagnet did
    const awkward = 'magnet:?xt=urn:btih:abc&dn=:1~'
    const b64 = btoa(awkward)
    expect(b64, 'the fixture no longer produces the character this test is about').toContain('+')
    const path = embedPath({ magnet: awkward, mode: 'watch' })!
    const readBack = new URLSearchParams(path.slice(path.indexOf('?'))).get('magnet')
    expect(readBack).toBe(b64)
    expect(atob(readBack!)).toBe(awkward)
  })
})

/**
 * A magnet is not guaranteed to be Latin-1, and `btoa` throws on anything above U+00FF.
 *
 * This is not a hypothetical shape: plenty of sites put the release name on the clipboard with its
 * own characters intact, so `&dn=映画の題名` is an ordinary paste. Every caller here builds a link
 * inside a render, so a throw does not fail the link, it takes out the whole route and leaves the
 * page blank until a reload.
 */
describe('a magnet that btoa cannot take', () => {
  const UNICODE = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=映画の題名'

  it('is exactly the input that throws, so the guard has something to guard', () => {
    expect(() => btoa(UNICODE)).toThrow()
  })

  it('encodes it anyway, by percent-encoding what the query can hold', () => {
    const encoded = encodeMagnet(UNICODE)
    expect(encoded).not.toBeNull()
    expect(atob(encoded!)).toBe('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=%E6%98%A0%E7%94%BB%E3%81%AE%E9%A1%8C%E5%90%8D')
  })

  it('keeps naming the same torrent, which is the only part that has to survive', () => {
    const back = atob(encodeMagnet(UNICODE)!)
    const params = new URLSearchParams(back.slice(back.indexOf('?')))
    expect(params.get('xt')).toBe('urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10')
    // and the name comes back readable, because the reader decodes
    expect(params.get('dn')).toBe('映画の題名')
  })

  it('builds a link for it instead of throwing mid-render', () => {
    expect(() => embedPath({ magnet: UNICODE, mode: 'watch' })).not.toThrow()
    expect(embedPath({ magnet: UNICODE, mode: 'watch' })).toContain('/embed?magnet=')
  })

  it('leaves an ordinary magnet byte for byte alone', () => {
    expect(encodeMagnet(MAGNET)).toBe(btoa(MAGNET))
  })

  /** null rather than a throw, so the caller renders its no-link branch */
  it('gives back null for something no encoding can save', () => {
    expect(encodeMagnet('\u{1F600} not a url')).toBeNull()
    expect(embedPath({ magnet: '\u{1F600} not a url', mode: 'watch' })).toBeNull()
    expect(embedUrl({ magnet: '\u{1F600} not a url', mode: 'watch' }, 'https://x')).toBeNull()
    expect(embedIframe({ magnet: '\u{1F600} not a url', mode: 'watch' }, 'https://x')).toBeNull()
  })
})

describe('embedUrl and embedIframe', () => {
  it('makes an absolute link against the given origin', () => {
    expect(embedUrl({ magnet: MAGNET, mode: 'watch' }, 'https://torrent.fkn.app'))
      .toBe('https://torrent.fkn.app/embed?magnet=' + encodeURIComponent(btoa(MAGNET)))
  })

  /**
   * Without allow-downloads a download embed is silently dark: nested sandbox flags are the union of
   * the embedder's and the frame's, so the page inside cannot restore what the page outside withheld,
   * and Chrome refuses with no event and nothing thrown.
   */
  it('asks for allow-downloads on a download embed and not on a watch one', () => {
    const download = embedIframe({ magnet: MAGNET, mode: 'download' }, 'https://x.test')
    const watch = embedIframe({ magnet: MAGNET, mode: 'watch' }, 'https://x.test')
    expect(download).toContain('allow-downloads')
    expect(watch).not.toContain('allow-downloads')
    // both still need their own origin, or the engine cannot reach its storage
    expect(download).toContain('allow-same-origin')
    expect(watch).toContain('allow-same-origin')
  })
})
