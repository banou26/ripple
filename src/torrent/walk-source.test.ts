import { describe, expect, it, vi } from 'vitest'

import { MAX_DEPTH, MAX_FILES, WalkCancelled, changedSince, isJunk, readPicked, walkDirectory } from './walk-source'

/**
 * An in-memory stand-in for a picked directory.
 *
 * Only the three things the walk actually uses: `kind`, `entries()` and `getFile()`. Building it by
 * hand rather than reaching for a mock library keeps the shape of what is being relied on visible,
 * which matters because the real object is a browser API this code cannot change.
 */
type Tree = { [name: string]: Tree | { bytes: Uint8Array, lastModified?: number, unreadable?: boolean } }

const isFile = (node: Tree[string]): node is { bytes: Uint8Array, lastModified?: number, unreadable?: boolean } =>
  node !== null && typeof node === 'object' && 'bytes' in node

const dirHandle = (name: string, tree: Tree): FileSystemDirectoryHandle => ({
  kind: 'directory',
  name,
  entries: async function* () {
    for (const [child, node] of Object.entries(tree)) {
      yield [child, isFile(node) ? fileHandle(child, node) : dirHandle(child, node)] as [string, FileSystemHandle]
    }
  },
} as unknown as FileSystemDirectoryHandle)

const fileHandle = (
  name: string,
  { bytes, lastModified = 1_000, unreadable = false }: { bytes: Uint8Array, lastModified?: number, unreadable?: boolean },
): FileSystemFileHandle => ({
  kind: 'file',
  name,
  getFile: async () => {
    if (unreadable) throw new DOMException('not readable', 'NotAllowedError')
    return {
      size: bytes.length,
      lastModified,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File
  },
} as unknown as FileSystemFileHandle)

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill)

const nest = (depth: number): Tree => {
  let tree: Tree = { 'deep.mkv': { bytes: bytes(1) } }
  for (let i = 0; i < depth; i++) tree = { [`d${i}`]: tree }
  return tree
}

describe('what counts as junk', () => {
  it('names three files the operating system writes, and nothing else', () => {
    expect(isJunk('.DS_Store')).toBe(true)
    expect(isJunk('Thumbs.db')).toBe(true)
    expect(isJunk('desktop.ini')).toBe(true)
  })

  /**
   * The rule is a list, not a pattern, and this is the case that says so. "Skip anything starting
   * with a dot" would drop a subtitle track or a config file somebody put there on purpose, and a
   * torrent missing a file the person picked is worse than one carrying Thumbs.db.
   */
  it('keeps other dotfiles, which somebody may well have meant', () => {
    expect(isJunk('.gitignore')).toBe(false)
    expect(isJunk('.hidden.mkv')).toBe(false)
    expect(isJunk('thumbs.db')).toBe(false)
  })
})

describe('walking a picked folder', () => {
  it('returns every file with its path relative to the folder, not including it', async () => {
    const root = dirHandle('Pack', {
      'E01.mkv': { bytes: bytes(10) },
      Subs: { 'E01.ass': { bytes: bytes(4) } },
    })
    const { files, skipped, truncated } = await walkDirectory(root)
    expect(files.map((f) => f.path.join('/')).sort()).toEqual(['E01.mkv', 'Subs/E01.ass'])
    expect(files.map((f) => f.size).reduce((a, b) => a + b, 0)).toBe(14)
    expect(skipped).toEqual([])
    expect(truncated).toBe(false)
  })

  it('keeps a handle per file, which is what a read is served from later', async () => {
    const root = dirHandle('Pack', { 'a.mkv': { bytes: bytes(6, 9) } })
    const { files } = await walkDirectory(root)
    expect(await readPicked(files[0]!, 2, 3)).toEqual(bytes(3, 9))
  })

  it('leaves out junk and says which files it left out', async () => {
    const root = dirHandle('Pack', {
      'E01.mkv': { bytes: bytes(10) },
      '.DS_Store': { bytes: bytes(6) },
      Subs: { 'Thumbs.db': { bytes: bytes(2) }, 'E01.ass': { bytes: bytes(4) } },
    })
    const { files, skipped } = await walkDirectory(root)
    expect(files.map((f) => f.path.join('/')).sort()).toEqual(['E01.mkv', 'Subs/E01.ass'])
    expect(skipped.sort()).toEqual(['.DS_Store', 'Subs/Thumbs.db'])
  })

  it('skips one unreadable file with a reason rather than failing the whole walk', async () => {
    const root = dirHandle('Pack', {
      'ok.mkv': { bytes: bytes(3) },
      'cloud.mkv': { bytes: bytes(3), unreadable: true },
    })
    const { files, skipped } = await walkDirectory(root)
    expect(files.map((f) => f.path.join('/'))).toEqual(['ok.mkv'])
    expect(skipped).toEqual(['cloud.mkv (could not be read)'])
  })

  it('records a zero-byte file rather than dropping it', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', { 'empty': { bytes: bytes(0) } }))
    expect(files).toHaveLength(1)
    expect(files[0]!.size).toBe(0)
  })

  /**
   * A symlink pointing at its own ancestor presents as an ordinary directory, and the platform gives
   * no way to tell: `kind` says 'directory' and that is all there is. So a loop cannot be detected,
   * only bounded, and the bound has to hold rather than recursing until the stack goes.
   */
  it('stops at a depth cap instead of following a directory loop forever', async () => {
    const root = dirHandle('Pack', nest(MAX_DEPTH + 4))
    const { files, skipped } = await walkDirectory(root)
    expect(files).toHaveLength(0)
    expect(skipped.some((s) => s.includes('nested too deep'))).toBe(true)
  })

  it('reaches a file that sits just inside the depth cap', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', nest(MAX_DEPTH - 1)))
    expect(files).toHaveLength(1)
  })

  it('says it truncated rather than pretending a huge pick was the whole of it', async () => {
    const many: Tree = {}
    for (let i = 0; i <= MAX_FILES; i++) many[`f${i}`] = { bytes: bytes(0) }
    const { files, truncated } = await walkDirectory(dirHandle('Pack', many))
    expect(truncated).toBe(true)
    expect(files.length).toBe(MAX_FILES)
  })

  it('counts as it goes, so a big tree does not look frozen', async () => {
    const root = dirHandle('Pack', { a: { bytes: bytes(1) }, b: { bytes: bytes(1) }, c: { bytes: bytes(1) } })
    const onFound = vi.fn()
    await walkDirectory(root, { onFound })
    expect(onFound.mock.calls.map((c) => c[0])).toEqual([1, 2, 3])
  })

  it('stops on an abort', async () => {
    const root = dirHandle('Pack', { a: { bytes: bytes(1) }, b: { bytes: bytes(1) } })
    await expect(walkDirectory(root, { signal: AbortSignal.abort() })).rejects.toThrow(WalkCancelled)
  })

  it('refuses a handle this browser cannot list, rather than reporting an empty folder', async () => {
    const noEntries = { kind: 'directory', name: 'Pack' } as unknown as FileSystemDirectoryHandle
    await expect(walkDirectory(noEntries)).rejects.toThrow(/cannot list/)
  })
})

/**
 * The check that runs after hashing and before publishing.
 *
 * A file edited mid-pass produces pieces describing a mixture of two versions. Those hashes are
 * self-consistent, so the torrent publishes without complaint and then fails every piece a peer
 * asks for, which is a failure that looks like a network problem and is not one.
 */
describe('noticing the source changed', () => {
  it('says nothing when nothing moved', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', { 'a': { bytes: bytes(4) } }))
    expect(await changedSince(files)).toEqual([])
  })

  it('catches a file that grew', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', { 'a': { bytes: bytes(4) } }))
    const grown = [{ ...files[0]!, handle: fileHandle('a', { bytes: bytes(9) }) }]
    expect(await changedSince(grown)).toEqual([{ path: 'a', was: 4, now: 9 }])
  })

  /** Same size, different mtime: a replaced file, which a size check alone reads as unchanged. */
  it('catches a file replaced with one of the same size', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', { 'a': { bytes: bytes(4), lastModified: 1_000 } }))
    const touched = [{ ...files[0]!, handle: fileHandle('a', { bytes: bytes(4), lastModified: 2_000 }) }]
    expect(await changedSince(touched)).toHaveLength(1)
  })

  it('catches a file that went away', async () => {
    const { files } = await walkDirectory(dirHandle('Pack', { 'a': { bytes: bytes(4) } }))
    const gone = [{ ...files[0]!, handle: fileHandle('a', { bytes: bytes(4), unreadable: true }) }]
    expect(await changedSince(gone)).toEqual([{ path: 'a', was: 4, now: -1 }])
  })
})
