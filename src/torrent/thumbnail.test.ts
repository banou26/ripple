import { describe, expect, it } from 'vitest'

import { downloadedFraction, pickThumbnailSource, rangeIsDownloaded, readableKeyframes } from './thumbnail'

let nextIndex = 0
const file = (name: string, size: number) => ({ name, size, progress: 0, index: nextIndex++ })

/*
 * The narrowing the download page needs, and the trap in doing it the obvious way.
 *
 * A cover image outranks a video, and an image needs every byte where a video needs its first 512
 * KiB. A link naming one episode never fetches the cover, so the page waited on a file it was not
 * downloading while the video it WAS downloading sat there ready. Measured: a picture that never
 * appeared at 58 per cent, on two browsers, which read as a browser difference and was not one.
 */
describe('narrowing which files may supply the picture', () => {
  const pack = () => {
    nextIndex = 0
    return [
      file('Pack/cover.jpg', 46_115),
      file('Pack/E01.mkv', 1_000_000_000),
      file('Pack/E02.mkv', 2_000_000_000),
    ]
  }

  it('still prefers the cover when the link asked for everything', () => {
    const source = pickThumbnailSource(pack(), () => true)
    expect(source?.kind).toBe('image')
    expect(source?.index).toBe(0)
  })

  it('falls to the video the link actually asked for when the cover is not among them', () => {
    // files=2, which is E02 alone: the cover is never downloaded, so it can never supply a picture
    const source = pickThumbnailSource(pack(), (index) => index === 2)
    expect(source?.kind).toBe('video')
    expect(source?.index).toBe(2)
  })

  /*
   * THE INDEX IS A POSITION IN THE ARRAY, so narrowing must never be done by filtering the list.
   * A filtered array renumbers everything after the first gap and the source then names a different
   * file than the one it measured, which is the mistake the Watch button made once already.
   */
  it('keeps the engine index, which filtering the list beforehand would not', () => {
    const files = pack()
    const viaPredicate = pickThumbnailSource(files, (index) => index === 2)
    const viaFilteredList = pickThumbnailSource(files.filter((_, index) => index === 2))
    expect(viaPredicate?.index).toBe(2)
    expect(viaFilteredList?.index, 'a filtered list renumbers, which is why the predicate exists').toBe(0)
    expect(viaPredicate?.name).toBe(viaFilteredList?.name)
  })

  it('finds nothing when the link asked only for files that cannot be pictured', () => {
    expect(pickThumbnailSource(pack(), (index) => index === 999)).toBeNull()
  })
})

describe('pickThumbnailSource', () => {
  it('finds nothing in a torrent with no media', () => {
    expect(pickThumbnailSource([file('readme.txt', 100), file('setup.exe', 9e8)])).toBeNull()
    expect(pickThumbnailSource([])).toBeNull()
    expect(pickThumbnailSource(undefined)).toBeNull()
  })

  it('takes the largest video when there is no artwork', () => {
    const source = pickThumbnailSource([
      file('Pack/sample.mkv', 40_000_000),
      file('Pack/feature.mkv', 8_000_000_000),
      file('Pack/notes.txt', 900),
    ])
    expect(source).toEqual({ index: 1, kind: 'video', size: 8_000_000_000, name: 'Pack/feature.mkv' })
  })

  /**
   * A release that ships cover art shipped it to BE the picture, and reading it costs one range
   * instead of opening a demuxer over a swarm.
   */
  it('prefers artwork over a video even when the video is enormously bigger', () => {
    const source = pickThumbnailSource([
      file('Pack/feature.mkv', 8_000_000_000),
      file('Pack/cover.jpg', 240_000),
    ])
    expect(source).toEqual({ index: 1, kind: 'image', size: 240_000, name: 'Pack/cover.jpg' })
  })

  it('takes the largest image, on the assumption that cover art outweighs an icon', () => {
    const source = pickThumbnailSource([
      file('Pack/folder.ico', 1_000),
      file('Pack/cover.png', 400_000),
      file('Pack/thumb.jpg', 9_000),
    ])
    expect(source?.name).toBe('Pack/cover.png')
  })

  /** An image is cached as read, so a huge scan is not worth pulling off the swarm to show at 64px. */
  it('ignores an image too large to be worth reading whole, and falls back to the video', () => {
    const source = pickThumbnailSource([
      file('Pack/scan.png', 60 * 1024 * 1024),
      file('Pack/feature.mkv', 8_000_000_000),
    ])
    expect(source).toEqual({ index: 1, kind: 'video', size: 8_000_000_000, name: 'Pack/feature.mkv' })
  })

  /**
   * libav decodes in wasm and hands back pixels, so it opens files the remuxer refuses outright.
   * A file that cannot be PLAYED here can still have its picture taken.
   */
  it('accepts video formats the player itself cannot open', () => {
    expect(pickThumbnailSource([file('old.vob', 1e9)])?.kind).toBe('video')
    expect(pickThumbnailSource([file('cam.m2ts', 1e9)])?.kind).toBe('video')
    expect(pickThumbnailSource([file('clip.rmvb', 1e9)])?.kind).toBe('video')
  })

  it('reports the ENGINE index, not a position among the media files', () => {
    const source = pickThumbnailSource([
      file('Pack/a.txt', 1),
      file('Pack/b.nfo', 1),
      file('Pack/c.srt', 1),
      file('Pack/feature.mp4', 1e9),
    ])
    expect(source?.index).toBe(3)
  })
})

describe('rangeIsDownloaded', () => {
  it('needs one run to cover the whole span', () => {
    expect(rangeIsDownloaded([[0, 100]], 0, 100)).toBe(true)
    expect(rangeIsDownloaded([[0, 100]], 10, 90)).toBe(true)
    expect(rangeIsDownloaded([[0, 100]], 0, 101)).toBe(false)
  })

  /**
   * Two touching runs are not one run here, and that is deliberate rather than an oversight: the
   * caller's runs come from the piece bitfield, where a gap between them means missing pieces. Two
   * ranges that meet exactly cannot occur, so accepting a span across them could only ever accept a
   * span across a hole.
   */
  it('refuses a span that crosses a gap', () => {
    expect(rangeIsDownloaded([[0, 50], [60, 100]], 40, 70)).toBe(false)
  })

  it('treats an empty span as satisfied, so a zero length read is not an error', () => {
    expect(rangeIsDownloaded([], 10, 10)).toBe(true)
    expect(rangeIsDownloaded([], 10, 5)).toBe(true)
  })

  it('is false against nothing at all', () => {
    expect(rangeIsDownloaded([], 0, 1)).toBe(false)
  })
})

describe('downloadedFraction', () => {
  it('adds the runs up', () => {
    expect(downloadedFraction([[0, 25], [50, 75]], 100)).toBe(0.5)
  })

  it('never exceeds one, and survives a zero size', () => {
    expect(downloadedFraction([[0, 200]], 100)).toBe(1)
    expect(downloadedFraction([[0, 200]], 0)).toBe(0)
  })
})

describe('readableKeyframes', () => {
  const frames = [
    { timestamp: 0, pos: 0 },
    { timestamp: 60, pos: 10_000_000 },
    { timestamp: 120, pos: 20_000_000 },
    { timestamp: 3600, pos: 600_000_000 },
  ]
  const SIZE = 1_000_000_000

  it('finds nothing when nothing is on disk', () => {
    expect(readableKeyframes(frames, [], SIZE)).toEqual([])
  })

  /**
   * The first frame of a film is usually black or a distributor card, so the deepest readable frame
   * inside the opening stretch is the one worth taking.
   */
  it('takes the deepest frame it can reach rather than the first', () => {
    // the head only: frames at 0, 60 and 120 are covered, the one at an hour in is not
    const [best] = readableKeyframes(frames, [[0, 25_000_000]], SIZE)
    expect(best).toBe(120)
  })

  it('offers fallbacks after its first choice, since a listed keyframe can still fail to decode', () => {
    expect(readableKeyframes(frames, [[0, 25_000_000]], SIZE)).toEqual([120, 0, 60])
  })

  /**
   * A keyframe needs more than the byte it starts at. Accepting one whose window runs past the end
   * of a downloaded run hands libav a truncated packet, which fails inside the worker rather than
   * here, where it would look like an unsupported file.
   */
  it('refuses a keyframe whose window runs past the end of the downloaded run', () => {
    // pos 20_000_000 with a 4 MB window needs bytes up to 24 MB, and the run stops at 21 MB
    expect(readableKeyframes(frames, [[0, 21_000_000]], SIZE)).toEqual([60, 0])
  })

  it('allows the window to be clipped by the end of the file rather than the run', () => {
    const tail = [{ timestamp: 10, pos: 900 }]
    // the file is 1000 bytes, so a 4 MB window cannot be satisfied by anything but the file's end
    expect(readableKeyframes(tail, [[0, 1000]], 1000)).toEqual([10])
  })

  it('drops a keyframe positioned outside the file', () => {
    const broken = [{ timestamp: 5, pos: -1 }, { timestamp: 6, pos: SIZE + 1 }]
    expect(readableKeyframes(broken, [[0, SIZE]], SIZE)).toEqual([])
  })

  it('caps how many it hands back, because each one costs a decode', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ timestamp: i, pos: i * 1000 }))
    expect(readableKeyframes(many, [[0, SIZE]], SIZE)).toHaveLength(4)
  })

  /**
   * On a complete file every keyframe is readable, so the opening window is what stops this landing
   * an hour into a film where a poster frame is a spoiler and a black scene is likely.
   */
  it('stays inside the opening even when the whole file is readable', () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ timestamp: i * 30, pos: i * 1_000_000 }))
    const [best] = readableKeyframes(long, [[0, SIZE]], SIZE)
    expect(best).toBe(300)
  })
})
