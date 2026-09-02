/**
 * Which file a row acts on when nobody has said.
 *
 * `pickVideoFile` answers with an index into the list it was handed, and three callers hand it the
 * UNFILTERED engine list: `watchHref` below, and the row's own Save at `home.tsx:1758` and `:2400`.
 * So a wrong answer here is not cosmetic, it is a player opened on zeroes or a pad written to disk
 * under an episode's name.
 */
import { describe, expect, it } from 'vitest'

import { canOfferWatch, pickVideoFile } from '../../src/torrent/watch'

const file = (name: string, size: number, pad = false) => ({ name, size, pad })

describe('choosing the file a row acts on', () => {
  it('takes the largest video, not merely the largest file', () => {
    expect(pickVideoFile([
      file('notes.txt', 900_000_000),
      file('small.mkv', 10),
      file('big.mkv', 20),
    ])).toBe(2)
  })

  it('falls back to the largest file when nothing is named like a video', () => {
    expect(pickVideoFile([file('a.bin', 5), file('b.bin', 50), file('c.bin', 5)])).toBe(1)
  })

  /*
   * The fallback is where a pad could win, and the sizes here are chosen so it would.
   *
   * A pad is named `.pad/65536`, so it never matches the video pass and the first loop was always
   * safe. The second takes the biggest file outright. With every real file smaller than the pad, the
   * unguarded version returned index 1: the caller then offered to play or save 65 KiB of zeroes.
   */
  it('never answers with a pad, even when the pad is the biggest thing in the torrent', () => {
    const files = [file('readme.txt', 10), file('.pad/65536', 65_536, true), file('data.bin', 500)]
    expect(pickVideoFile(files)).toBe(2)
  })

  it('keeps a pad out of the video pass too', () => {
    // a pad that somehow reads as a video name must still lose to the real one
    const files = [file('.pad/movie.mkv', 900_000_000, true), file('real.mkv', 10)]
    expect(pickVideoFile(files)).toBe(1)
  })

  it('answers 0 for an empty or unknown list rather than -1', () => {
    // -1 would index nothing, and every caller passes the result straight to the engine
    expect(pickVideoFile([])).toBe(0)
    expect(pickVideoFile(undefined)).toBe(0)
    expect(pickVideoFile([file('.pad/1', 1, true)])).toBe(0)
  })

  /** A list with no video is not a list that has not arrived, and the two must not read alike. */
  it('offers watch for an unknown file list and refuses one with nothing playable', () => {
    expect(canOfferWatch(undefined)).toBe(true)
    expect(canOfferWatch([{ name: 'a.mkv' }])).toBe(true)
    expect(canOfferWatch([{ name: 'a.txt' }, { name: 'b.zip' }])).toBe(false)
  })
})
