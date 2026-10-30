import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { compileFileSelection, embedIframe, embedPath, embedUrl, linkLanguages } from '../../src/router/embed-link'
import { parseFileSelection, resolveSelection } from '../../src/router/file-selection'
import { decodeMagnetParam, encodeMagnetParam } from '../../src/router/magnet-codec'

/** What a built path actually names, read back the way /watch reads it. */
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
  it('carries the magnet and nothing else for a plain watch link', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'watch' })!
    expect(path).toBe(`/watch?m=${encodeMagnetParam(MAGNET)!.value}`)
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
     * fixed characters sat on both sides of the comparison, diluting the ratio the codec is
     * answerable for, and at this magnet's length that alone pushed 2x out of reach. That parameter
     * is gone, but the claim being made is still about the encoding, so the encoding is still what
     * is measured.
     */
    expect(encoded.key, 'fell back to base64 for a magnet the packed form can hold').toBe('m')
    expect(`m=${encoded.value}`.length)
      .toBeLessThan(`magnet=${encodeURIComponent(btoa(MAGNET))}`.length / 2)
  })

  it('names a file on a watch link with fileIndex, which is what the player reads', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 5 })).toContain('fileIndex=5')
  })

  // an absent fileIndex lets the player pick the video file, which need not be file 0
  it('names file 0 too, and leaves fileIndex off only when no file is given', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 0 })).toContain('fileIndex=0')
    expect(embedPath({ magnet: MAGNET, mode: 'watch' })).not.toContain('fileIndex')
  })

  /**
   * THE PATH SAYS WHICH PAGE IT IS, so a link is told apart by the part of a URL a person reads
   * first rather than by a parameter buried behind a packed magnet. `mode=watch` did that job for a
   * while and cost 11 characters of query to do it; a path costs nothing and cannot be missed. It is
   * neither written nor read now, so a link that carries one is carrying junk.
   */
  it('puts the mode in the path and writes no mode parameter at all', () => {
    const watch = embedPath({ magnet: MAGNET, mode: 'watch' })!
    const download = embedPath({ magnet: MAGNET, mode: 'download' })!
    expect(watch.startsWith('/watch?')).toBe(true)
    expect(download.startsWith('/download?')).toBe(true)
    expect(watch).not.toContain('mode=')
    expect(download).not.toContain('mode=')
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
    expect(path!.startsWith('/download?')).toBe(true)
    expect(path).toContain('files=1-2')
    expect(path).not.toContain('fileIndex')
  })

  it('omits files when the download names the whole torrent', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', indices: [0, 1, 2], fileCount: 3 })
    expect(path!.startsWith('/download?')).toBe(true)
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
    expect(path).toMatch(/^\/watch\?m=[A-Za-z0-9\-_]+$/)
  })
})

/**
 * A magnet is not guaranteed to be Latin-1, and `btoa` throws on anything above U+00FF.
 *
 * This is not a hypothetical shape: plenty of sites put the release name on the clipboard with its
 * own characters intact, so `&dn=進撃の巨人` is an ordinary paste. Every caller here builds a link
 * inside a render, so a throw does not fail the link, it takes out the whole route and leaves the
 * page blank until a reload.
 */
describe('a magnet that btoa cannot take', () => {
  const UNICODE = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=進撃の巨人'

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
    expect(params.get('dn')).toBe('進撃の巨人')
  })

  it('builds a link for it instead of throwing mid-render', () => {
    expect(() => embedPath({ magnet: UNICODE, mode: 'watch' })).not.toThrow()
    const path = embedPath({ magnet: UNICODE, mode: 'watch' })!
    // read as a param rather than matched as a substring: `m` leads the query now that no mode
    // precedes it, so a test looking for `&m=` passes only by accident of parameter order
    expect(new URLSearchParams(path.slice(path.indexOf('?'))).get('m')).toBeTruthy()
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
      .toBe('https://torrent.fkn.app/watch?m=' + encodeMagnetParam(MAGNET)!.value)
    expect(embedUrl({ magnet: MAGNET, mode: 'download' }, 'https://torrent.fkn.app'))
      .toBe('https://torrent.fkn.app/download?m=' + encodeMagnetParam(MAGNET)!.value)
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
 * WHAT A LINK IS ALLOWED TO SAY, which is the smaller half of what it used to.
 *
 * A link asks for a torrent and for files within it. It carries nothing describing those files: no
 * names, no sizes, no count. That was a deliberate removal rather than something never built, so it
 * is pinned here, because the shape of a URL is the kind of thing that grows back.
 */
describe('a link describes no files, only which ones it wants', () => {
  it('carries no file list on a download link', () => {
    const path = embedPath({ magnet: MAGNET, mode: 'download', indices: [0, 2], fileCount: 5 })!
    // the comma is percent encoded by URLSearchParams, which is what actually ships
    expect(path).toContain('files=0%2C2')
    expect(path).not.toContain('&f=')
  })

  /**
   * The two cases that need no selection at all, which is most links: every file picked, and a
   * torrent with one file, where those are the same statement.
   */
  it('says nothing about files when the link wants all of them', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'download', indices: [0, 1, 2], fileCount: 3 })!)
      .not.toContain('files=')
    expect(embedPath({ magnet: MAGNET, mode: 'download', indices: [0], fileCount: 1 })!)
      .not.toContain('files=')
    expect(embedPath({ magnet: MAGNET, mode: 'download' })!).not.toContain('files=')
  })

  /**
   * A whole-torrent download link is now the same length as the watch link for the same torrent,
   * give or take the path. It used to be about 60 per cent longer on a single-file release, and all
   * of that difference was a file list the page threw away the moment metadata arrived.
   */
  it('is no longer than the watch link for the same torrent', () => {
    const download = embedPath({ magnet: MAGNET, mode: 'download' })!
    const watch = embedPath({ magnet: MAGNET, mode: 'watch' })!
    expect(download.length - watch.length).toBeLessThanOrEqual('/download'.length - '/watch'.length)
  })
})

describe('the language on a link', () => {
  const read = (language: string) => linkLanguages(new URLSearchParams({ language }))
  const queryOf = (path: string) => new URLSearchParams(path.slice(path.indexOf('?')))

  it('names no language when the link names none', () => {
    expect(linkLanguages(new URLSearchParams())).toEqual({})
    expect(read('')).toEqual({})
  })

  it('reads a language the player has, written as Intl writes it and without extensions', () => {
    expect(read('fr')).toEqual({ language: 'fr' })
    expect(read('FR-ca')).toEqual({ language: 'fr-CA' })
    expect(read('fr-u-nu-arab')).toEqual({ language: 'fr' })
    expect(read('en-GB')).toEqual({ language: 'en-GB' })
  })

  // the tags the player's own matching serves through another catalogue, which a list of its catalogues would refuse
  it('reads a region of a language the player has', () => {
    for (const language of ['es-MX', 'pt-PT', 'zh-TW']) expect(read(language)).toEqual({ language })
  })

  it.each(['fr_FR', 'fr-CA-', '<script>', 'x'.repeat(300)])('leaves out %s, which Intl cannot read', (tag) => {
    expect(read(tag)).toEqual({})
  })

  it.each(['xx', 'tlh', 'sv', 'und', 'und-FR'])('leaves out %s, which the player has no text in', (tag) => {
    expect(read(tag)).toEqual({})
  })

  // fails when a media-player update brings a language this list has not heard of
  it('reads every language of the installed player', () => {
    const catalogues = readdirSync(new URL('../../node_modules/@banou/media-player/src/lib/locales', import.meta.url))
      .filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''))
    expect(catalogues).toContain('fr')
    for (const language of catalogues) expect(read(language), language).toEqual({ language })
  })

  it('is written on both routes, ahead of the packed torrent', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch', fileIndex: 2, language: 'fr' })).toMatch(/^\/watch\?fileIndex=2&language=fr&m=/)
    expect(embedPath({ magnet: MAGNET, mode: 'download', indices: [1, 2], fileCount: 9, language: 'fr' })).toMatch(/^\/download\?files=1-2&language=fr&m=/)
  })

  it('is left off a link naming none', () => {
    expect(embedPath({ magnet: MAGNET, mode: 'watch' })).not.toContain('language')
  })

  it('reads back as written', () => {
    const written = linkLanguages(queryOf(embedPath({ magnet: MAGNET, mode: 'watch', language: 'zh-TW' })!))
    expect(written).toEqual({ language: 'zh-TW' })
    expect(linkLanguages(queryOf(embedPath({ magnet: MAGNET, mode: 'watch', ...written })!))).toEqual(written)
  })
})
