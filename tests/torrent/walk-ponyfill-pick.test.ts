import { afterEach, describe, expect, it, vi } from 'vitest'

import { showDirectoryPicker, showOpenFilePicker } from '@banou/ponyfill'

import { changedSince, pickedFile, readPicked, walkDirectory } from '../../src/torrent/walk-source'

/**
 * Ripple's walk, over a handle the ponyfill BUILT rather than one the platform gave.
 *
 * This is the join the whole picker change rests on and the one thing neither side's own tests can
 * see. The ponyfill pins that its wrapped handles have the right shape; ripple pins that its walk
 * reads a directory handle. Only a test holding both at once can say that the shape ripple asks for
 * and the shape the ponyfill provides are the same one, and the failure it guards against is the
 * expensive kind: creating a torrent stops working on Firefox and WebKit only, where the wrapped
 * handle is the only kind there is.
 *
 * Driven with no browser at all. The ponyfill opens an `<input type="file">` where an engine has no
 * picker, so a fake document is enough to reach the whole path: the tree it rebuilds from
 * `webkitRelativePath`, the handles it hands back, and every method ripple calls on them.
 */
afterEach(() => { vi.unstubAllGlobals() })

/**
 * Bytes that COUNT UP from a per-file seed, rather than a constant fill.
 *
 * A file of identical bytes cannot tell an offset read from a read at zero, and two files of
 * identical bytes cannot tell which size was attached to which path. Both are exactly what this file
 * is here to check, so the content has to distinguish them.
 */
const fileAt = (path: string, size: number, seed = 0, lastModified = 1_700_000_000_000): File => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (seed + i) % 251
  const file = new File([bytes], path.split('/').pop()!, { lastModified })
  Object.defineProperty(file, 'webkitRelativePath', { value: path.includes('/') ? path : '' })
  return file
}

/**
 * A document whose one input answers with these files, which is what a person picking a folder is.
 *
 * The same fake the ponyfill's own suite uses, kept here rather than shared: a test that imported
 * the other package's test helper would stop being a test of the boundary between them.
 */
const stubDocument = (files: File[]) => {
  vi.stubGlobal('document', {
    createElement: () => {
      const listeners = new Map<string, () => void>()
      const input = {
        type: '', multiple: false, accept: '', webkitdirectory: false, style: { display: '' },
        files,
        setAttribute: () => {},
        addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
        remove: () => {},
        click: () => listeners.get('change')?.(),
      }
      return input
    },
    body: { append: () => {} },
  })
}

const pickFolder = async (files: File[]) => {
  stubDocument(files)
  vi.stubGlobal('window', {})
  vi.stubGlobal('showDirectoryPicker', undefined)
  return showDirectoryPicker({ id: 'ripple-source', mode: 'read' })
}

describe('ripple walks a folder the ponyfill wrapped', () => {
  it('reads the whole tree, with the paths relative to the picked folder', async () => {
    const root = await pickFolder([
      fileAt('Pack/E01.mkv', 40, 1),
      fileAt('Pack/Subs/E01.ass', 12, 2),
      fileAt('Pack/E02.mkv', 41, 3),
    ])
    expect(root.name, 'the folder names the torrent').toBe('Pack')

    const walked = await walkDirectory(root)
    // paired, not two sorted lists: a tree that hung E02's bytes off E01's path satisfies both of
    // those separately and is exactly the mismatch this file exists to catch
    expect(walked.files.map((file) => [file.path.join('/'), file.size]).sort())
      .toEqual([['E01.mkv', 40], ['E02.mkv', 41], ['Subs/E01.ass', 12]])
    expect(walked.truncated).toBe(false)
    expect(walked.skipped).toEqual([])
  })

  /**
   * The walk calls `entries()` and throws "this browser cannot list a picked folder" without it,
   * which is the exact failure a shape mismatch here would produce, on Firefox and WebKit only.
   */
  it('lists through entries(), which is what the walk actually asks for', async () => {
    const root = await pickFolder([fileAt('Pack/a.bin', 3)])
    const seen: string[] = []
    for await (const [name, handle] of (root as unknown as { entries: () => AsyncIterable<[string, { kind: string }]> }).entries()) {
      seen.push(`${name}:${handle.kind}`)
    }
    expect(seen).toEqual(['a.bin:file'])
  })

  it('skips the junk the walk skips, by the same rules', async () => {
    const walked = await walkDirectory(await pickFolder([
      fileAt('Pack/.DS_Store', 6),
      fileAt('Pack/keep.mkv', 9),
    ]))
    expect(walked.files.map((file) => file.path.join('/'))).toEqual(['keep.mkv'])
    expect(walked.skipped).toEqual(['.DS_Store'])
  })

  it('reads bytes back out of a wrapped file handle, at an offset', async () => {
    const walked = await walkDirectory(await pickFolder([fileAt('Pack/a.bin', 10, 100)]))
    const bytes = await readPicked(walked.files[0]!, 4, 3)
    expect(bytes.length, 'a short read publishes a torrent whose pieces describe nothing').toBe(3)
    // 104, 105, 106: the file counts up from 100, so a read that ignored the offset answers 100, 101, 102
    expect([...bytes], 'the offset was ignored, which mixes one piece into another').toEqual([104, 105, 106])
  })

  /**
   * The staleness check cannot SEE an edit through a wrapped handle, and that is a real limit rather
   * than a bug: the `File` behind it is a snapshot taken when it was picked, so its `lastModified`
   * never moves. What it must not do is report a change that did not happen, since a false positive
   * refuses a publish that was fine.
   */
  it('reports no staleness for a pick nothing has touched', async () => {
    const walked = await walkDirectory(await pickFolder([fileAt('Pack/a.bin', 10)]))
    expect(await changedSince(walked.files)).toEqual([])
  })

  it('reads a single picked file as its own torrent', async () => {
    stubDocument([fileAt('Movie.mkv', 21)])
    vi.stubGlobal('window', {})
    vi.stubGlobal('showOpenFilePicker', undefined)
    const [handle] = await showOpenFilePicker({ multiple: false })

    const picked = await pickedFile(handle!)
    expect(picked.path).toEqual(['Movie.mkv'])
    expect(picked.size).toBe(21)
    expect((await readPicked(picked, 0, 21)).length).toBe(21)
  })

  /**
   * THE ONE THING IT CANNOT DO, asserted rather than assumed, because ripple now decides the whole
   * copy question from it. A wrapped handle refuses to be stored, which is what tells the create
   * flow to copy the bytes instead of trusting a handle it could never get back.
   */
  it('refuses to be stored, which is what makes the copy happen', async () => {
    const root = await pickFolder([fileAt('Pack/a.bin', 3)])
    expect(() => structuredClone(root)).toThrow()
    try { structuredClone(root) } catch (error) { expect((error as Error).name).toBe('DataCloneError') }
  })
})
