import { describe, expect, it } from 'vitest'

import { compileFileSelection, embedIframe, embedPath, embedUrl } from './embed-link'
import { parseFileSelection, parseMode, resolveSelection } from './file-selection'
import { decodeFileList } from './file-list-codec'
import { decodeMagnetParam, encodeMagnetParam } from './magnet-codec'

/** What a built path actually names, read back the way /embed reads it. */
const magnetOf = (path: string) => decodeMagnetParam(new URLSearchParams(path.slice(path.indexOf('?') + 1)))

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
  it('carries the magnet and the mode for a plain watch link, and nothing else', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'watch' })!
    expect(path).toBe(`/embed?mode=watch&m=${encodeMagnetParam(MAGNET)!.value}`)
    expect(magnetOf(path)).toBe(MAGNET)
  })

  /**
   * The reason this module changed at all. Pinned as a floor rather than an exact length so a
   * dictionary or format change is free to do better, but a change that quietly stops packing and
   * falls back to base64 for every link cannot pass.
   */
  it('is far shorter than writing the magnet out as base64', () => {
    const encoded = encodeMagnetParam(MAGNET)!
    /*
     * The PARAMETER, not the whole path.
     *
     * It used to measure the path, which stopped working the day `&mode=watch` was added: eleven
     * fixed characters sit on both sides of the comparison and do nothing but dilute the ratio the
     * codec is answerable for, and at this magnet's length that alone pushed 2x out of reach. The
     * claim being made is about the encoding, so the encoding is what is measured.
     */
    expect(encoded.key, 'fell back to base64 for a magnet the packed form can hold').toBe('m')
    expect(`m=${encoded.value}`.length)
      .toBeLessThan(`magnet=${encodeURIComponent(btoa(MAGNET))}`.length / 2)
  })

  it('names a file on a watch link with fileIndex, which is what the player reads', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 5 })).toContain('fileIndex=5')
  })

  it('leaves fileIndex off when it is 0, because absent already means the first file', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 0 })).not.toContain('fileIndex')
  })

  /**
   * Both modes SAY which they are, so a link can be told apart by reading it rather than by noticing
   * that a parameter is missing. It costs 11 characters on a watch link, which is the deliberate
   * trade: everything else in the query is packed or an index, and this is the only part left that
   * a person is meant to read.
   */
  it('names the mode on both kinds of link, rather than leaving watch to be inferred', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch' })).toContain('mode=watch')
    expect(embedPath({ magnet: MAGNET, mode: 'download' })).toContain('mode=download')
  })

  /**
   * WRITING it must not change READING it. Every link published before this omits `mode`, and the
   * one shipped consumer passes only `magnet`, so an absent mode has to keep opening the player.
   * parseMode is what guarantees that; this is the round trip through the two of them together.
   */
  it('still opens the player for a link that names no mode at all', () => {
    const legacy = `/embed?magnet=${encodeURIComponent(btoa(MAGNET))}`
    expect(parseMode(new URLSearchParams(legacy.split('?')[1]).get('mode'))).toBe('watch')
    // and the mode this module now writes reads back as the same thing
    const written = embedPath({ magnet: MAGNET, mode: 'watch' })!
    expect(parseMode(new URLSearchParams(written.split('?')[1]).get('mode'))).toBe('watch')
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
   *
   * This magnet carries no hash the packer recognises, so it takes the legacy base64 branch, which
   * is exactly the branch that needs the escaping. The packed branch is base64url and needs none.
   */
  it('percent-encodes a base64 magnet rather than trusting it in a query string', () => {
    const awkward = 'magnet:?xt=urn:btih:abc&dn=:1~'
    const b64 = btoa(awkward)
    expect(b64, 'the fixture no longer produces the character this test is about').toContain('+')
    const path = embedPath({ magnet: awkward, mode: 'watch' })!
    const readBack = new URLSearchParams(path.slice(path.indexOf('?'))).get('magnet')
    expect(readBack).toBe(b64)
    expect(atob(readBack!)).toBe(awkward)
  })

  /**
   * The packed form is written with the base64url alphabet precisely so a query string carries it
   * untouched. If a `+`, `/` or `=` ever reached a link, URLSearchParams would spend three
   * characters escaping each one and hand back a space where a plus was.
   */
  it('writes the packed form with nothing a query string has to escape', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'watch' })!
    expect(path).toMatch(/^\/embed\?mode=watch&m=[A-Za-z0-9\-_]+$/)
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

  it('encodes it anyway, by normalizing to what the query can hold', () => {
    expect(encodeMagnetParam(UNICODE)).not.toBeNull()
  })

  it('keeps naming the same torrent, which is the only part that has to survive', () => {
    const back = magnetOf(embedPath({ magnet: UNICODE, mode: 'watch' })!)!
    const params = new URLSearchParams(back.slice(back.indexOf('?') + 1))
    expect(params.get('xt')).toBe('urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10')
    // and the name comes back readable, because the reader decodes
    expect(params.get('dn')).toBe('映画の題名')
  })

  it('builds a link for it instead of throwing mid-render', () => {
    expect(() => embedPath({ magnet: UNICODE, mode: 'watch' })).not.toThrow()
    expect(embedPath({ magnet: UNICODE, mode: 'watch' })).toContain('&m=')
  })

  /** null rather than a throw, so the caller renders its no-link branch */
  it('gives back null for something no encoding can save', () => {
    expect(encodeMagnetParam('\u{1F600} not a url')).toBeNull()
    expect(embedPath({ magnet: '\u{1F600} not a url', mode: 'watch' })).toBeNull()
    expect(embedUrl({ magnet: '\u{1F600} not a url', mode: 'watch' }, 'https://x')).toBeNull()
    expect(embedIframe({ magnet: '\u{1F600} not a url', mode: 'watch' }, 'https://x')).toBeNull()
  })
})

describe('embedUrl and embedIframe', () => {
  it('makes an absolute link against the given origin', () => {
    expect(embedUrl({ magnet: MAGNET, mode: 'watch' }, 'https://torrent.fkn.app'))
      .toBe('https://torrent.fkn.app/embed?mode=watch&m=' + encodeMagnetParam(MAGNET)!.value)
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

/**
 * The file list a download link can carry, so the recipient sees the release before the swarm
 * answers. Everything here is about when it is NOT written, because the failure that costs anything
 * is a link that got longer or lost its meaning, not one that skipped a preview.
 */
describe('the preview file list', () => {
  const FILES = Array.from({ length: 12 }, (_, i) => ({
    path: `Show.S01/Show.S01E${String(i + 1).padStart(2, '0')}.1080p.mkv`, size: (350 + i) * 1024 ** 2,
  }))

  it('rides along on a download link and reads back as the same list', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', preview: FILES })!
    const value = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('f')
    expect(value).not.toBeNull()
    expect(decodeFileList(value!)).toEqual(FILES)
  })

  /** The player reads `fileIndex` and renders no list, so a preview there is bytes nothing looks at. */
  it('is never put on a watch link', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', preview: FILES })).not.toContain('f=')
  })

  it('is simply absent when the sender has no file list, which is every plain magnet', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'download' })).not.toContain('&f=')
    expect(embedPath({ magnet: MAGNET, mode: 'download', preview: [] })).not.toContain('&f=')
  })

  /**
   * The preview is a convenience and the link is not. A list too big to encode has to cost the
   * preview, never the link, so this pins that the rest of the URL is untouched by its absence.
   */
  it('drops itself rather than bloating the link past what a chat will carry', () => {
    const enormous = Array.from({ length: 3000 }, (_, i) => ({
      path: `${i}-${(i * 2654435761 % 4294967296).toString(36)}${'zqx'.repeat(14)}.mkv`, size: i,
    }))
    const withHuge = embedPath({ magnet: MAGNET, mode: 'download', preview: enormous })!
    expect(withHuge).not.toContain('&f=')
    expect(withHuge).toBe(embedPath({ magnet: MAGNET, mode: 'download' }))
  })

  /**
   * The query is ordered plainest first: what the link DOES, then the packed torrent, then the long
   * preview blob. A URL is read left to right and truncated from the right, so the readable half
   * has to lead. The torrent used to, from when it was the only thing in the link.
   */
  it('leads with what the link does, then the torrent, then the long parameter', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', preview: FILES })!
    expect(path).toMatch(/^\/embed\?mode=download/)
    // `&m=` rather than `m=`, which would also match inside `mode=`
    expect(path.indexOf('&m=')).toBeLessThan(path.indexOf('&f='))
    expect(path.indexOf('mode=')).toBeLessThan(path.indexOf('&m='))
  })

  it('keeps a 12-episode season inside what a chat message will carry', () => {
    const url = embedUrl({ magnet: MAGNET, mode: 'download', preview: FILES }, 'https://torrent.fkn.app')!
    // Discord refuses a message over 2000 characters outright, the tightest real ceiling here
    expect(url.length).toBeLessThan(2000)
  })
})
