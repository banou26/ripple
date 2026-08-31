import { describe, expect, it } from 'vitest'

import { firstIndexOf, parseFileSelection, parseMode, resolveSelection } from '../../src/router/file-selection'

describe('the embed mode', () => {
  it('is the player unless download is asked for by name', () => {
    expect(parseMode(undefined)).toBe('watch')
    expect(parseMode(null)).toBe('watch')
    expect(parseMode('')).toBe('watch')
    expect(parseMode('watch')).toBe('watch')
    // the shipped consumer passes only `magnet`, so anything unrecognised has to keep playing
    expect(parseMode('player')).toBe('watch')
    expect(parseMode('DOWNLOAD')).toBe('download')
    expect(parseMode(' download ')).toBe('download')
  })
})

describe('the files grammar', () => {
  it('takes the whole torrent when nothing is asked for', () => {
    expect(parseFileSelection(undefined, undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('all', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('ALL', undefined)).toEqual({ kind: 'all' })
  })

  it('falls back to fileIndex, so &mode=download on a watch URL downloads what it was playing', () => {
    expect(parseFileSelection(undefined, '4')).toEqual({ kind: 'single', index: 4 })
    // `files` outranks it: the newer, more expressive param wins where both are present
    expect(parseFileSelection('1-3', '4')).toEqual({ kind: 'range', from: 1, to: 3 })
  })

  it('reads a single index, a range, and a mixed list', () => {
    expect(parseFileSelection('3', undefined)).toEqual({ kind: 'single', index: 3 })
    expect(parseFileSelection('0-4', undefined)).toEqual({ kind: 'range', from: 0, to: 4 })
    expect(parseFileSelection('0,2,5', undefined)).toEqual({
      kind: 'list',
      spans: [{ from: 0, to: 0 }, { from: 2, to: 2 }, { from: 5, to: 5 }],
    })
    expect(parseFileSelection('0-2,7', undefined)).toEqual({
      kind: 'list',
      spans: [{ from: 0, to: 2 }, { from: 7, to: 7 }],
    })
  })

  it('accepts a backwards range rather than resolving it to nothing', () => {
    expect(parseFileSelection('4-1', undefined)).toEqual({ kind: 'range', from: 1, to: 4 })
  })

  it('calls a range that names one file a single file, because that is what gets delivered', () => {
    // shape follows the count, not the syntax: a zip of one file is a worse download than the file
    expect(parseFileSelection('2-2', undefined)).toEqual({ kind: 'single', index: 2 })
  })

  it('ignores junk instead of throwing, and falls back to the whole torrent when nothing survives', () => {
    expect(parseFileSelection('abc', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('-', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection(',,,', undefined)).toEqual({ kind: 'all' })
    // Number(' 1 ') is 1 and Number('') is 0, so neither is safe to trust on a hand written URL
    expect(parseFileSelection('1.5', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('1e3', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('-2', undefined)).toEqual({ kind: 'all' })
    expect(parseFileSelection('2,oops', undefined)).toEqual({ kind: 'single', index: 2 })
  })
})

/**
 * `files` is written by hand into a URL by whoever embeds the page, so its width is not something
 * this code gets to assume anything about. Both of these hung the renderer before the parse stopped
 * materialising anything: the first as a multi-GB allocation, the second as a loop with no end.
 *
 * They are ordinary unit tests only because nothing is expanded until a file count bounds it. Under
 * the old shape they could not have been written at all, since the call never returned.
 */
describe('a selection far wider than any real torrent', () => {
  const withinAMoment = (run: () => unknown) => {
    const started = performance.now()
    const value = run()
    expect(performance.now() - started, 'must not scale with the width asked for').toBeLessThan(100)
    return value
  }

  it('parses a two billion wide range without expanding it', () => {
    expect(withinAMoment(() => parseFileSelection('0-2000000000', undefined)))
      .toEqual({ kind: 'range', from: 0, to: 2_000_000_000 })
  })

  it('parses the largest range the grammar can express', () => {
    expect(withinAMoment(() => parseFileSelection('0-9007199254740991', undefined)))
      .toEqual({ kind: 'range', from: 0, to: 9_007_199_254_740_991 })
  })

  it('resolves it against the torrent rather than against the number in the URL', () => {
    expect(withinAMoment(() => resolveSelection(parseFileSelection('0-2000000000', undefined), 4)))
      .toEqual([0, 1, 2, 3])
  })

  /**
   * `Math.min(...indices)` passed one argument per selected file and threw RangeError above roughly
   * 100k of them, inside a render, so the page did not merely stall: it never mounted.
   */
  it('finds the first index of a huge multi-part list without a spread', () => {
    const selection = parseFileSelection('900-2000000000,5', undefined)
    expect(selection.kind).toBe('list')
    expect(withinAMoment(() => firstIndexOf(selection))).toBe(5)
  })
})

describe('the first index of a selection', () => {
  it('is where the engine claim starts, before any file list exists', () => {
    expect(firstIndexOf({ kind: 'all' })).toBe(0)
    expect(firstIndexOf({ kind: 'single', index: 4 })).toBe(4)
    expect(firstIndexOf({ kind: 'range', from: 2, to: 9 })).toBe(2)
    // lowest, not first written: a list is in the order the URL gave it
    expect(firstIndexOf({ kind: 'list', spans: [{ from: 5, to: 5 }, { from: 1, to: 2 }] })).toBe(1)
  })
})

describe('resolving a selection against a real torrent', () => {
  it('expands everything, in order, without duplicates', () => {
    expect(resolveSelection({ kind: 'all' }, 3)).toEqual([0, 1, 2])
    expect(resolveSelection({ kind: 'range', from: 1, to: 3 }, 6)).toEqual([1, 2, 3])
    expect(resolveSelection({ kind: 'list', spans: [{ from: 5, to: 5 }, { from: 0, to: 0 }, { from: 2, to: 2 }] }, 6))
      .toEqual([0, 2, 5])
    // overlapping spans are merged rather than counted twice
    expect(resolveSelection({ kind: 'list', spans: [{ from: 0, to: 3 }, { from: 2, to: 4 }] }, 9))
      .toEqual([0, 1, 2, 3, 4])
  })

  /**
   * An index the torrent does not have is the embedder's mistake, and the page has to be able to say
   * so. Clamping it to the last file, or quietly widening to the whole torrent, would hand somebody
   * a different release than the one their URL named.
   */
  it('drops indices the torrent does not have rather than clamping them', () => {
    expect(resolveSelection({ kind: 'single', index: 9 }, 3)).toEqual([])
    expect(resolveSelection({ kind: 'range', from: 1, to: 99 }, 3)).toEqual([1, 2])
    expect(resolveSelection({ kind: 'list', spans: [{ from: 0, to: 0 }, { from: 42, to: 42 }] }, 3)).toEqual([0])
    expect(resolveSelection({ kind: 'range', from: 8, to: 9 }, 3)).toEqual([])
    expect(resolveSelection({ kind: 'all' }, 0)).toEqual([])
  })
})
