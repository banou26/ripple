import type { SourceFile } from './make-torrent'

/**
 * Walking a picked directory into the file list a torrent is built from.
 *
 * The walk keeps a FILE HANDLE per entry, and everything downstream indexes those by their position
 * in the list rather than by path. That is not a convenience: libtorrent SANITISES path elements
 * before it reports them back, so the path in `session.files(h)` is not reliably the path that went
 * into the info dict, and resolving a read by re-walking a reported path would work for ordinary
 * names and fail for the ones that most need it. A file's index in `files` is exact, because it is
 * the order the info dict was written in.
 *
 * The rules that decide what goes IN are pure and tested. The walk itself is the part that needs a
 * disk.
 */

/**
 * Files a picker hands over that nobody means to publish.
 *
 * Deliberately three names and not a pattern. A rule like "skip anything starting with a dot" would
 * quietly drop `.gitignore`, `.env.example` or a subtitle track somebody named deliberately, and a
 * torrent missing a file the person picked is worse than one carrying `Thumbs.db`. These three are
 * written by the operating system rather than by anyone, and carry a little about the machine that
 * made them. Everything else is shown and included, and the dialog lists what was left out.
 */
export const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export const isJunk = (name: string): boolean => JUNK_NAMES.has(name)

/**
 * Depth this walk will not go past.
 *
 * A `FileSystemDirectoryHandle` iterates whatever the operating system presents, and a symlink
 * pointing at its own ancestor presents as an ordinary directory: the platform gives no way to see
 * that it is a link, so the loop cannot be detected, only bounded. Sixteen is far past any real
 * release layout.
 */
export const MAX_DEPTH = 16

/** Past this the pick was a mistake, and the dialog says so instead of hashing for an hour. */
export const MAX_FILES = 20_000

/**
 * Where a picked file's bytes come from, which is not always a handle.
 *
 * A `FileSystemFileHandle` is a way to get a FRESH `File` on every read and it survives for as long
 * as its grant does. A `File` is ONE snapshot: readable for the life of the page, and impossible to
 * re-acquire after a reload without another pick.
 *
 * Both answer the only question anything downstream actually asks, which is "give me these bytes
 * now", so the whole create path takes either. The difference shows up in exactly two places and both
 * say so where they sit: {@link changedSince} cannot see an edit through a snapshot, and nothing can
 * re-open one after a reload, which is what makes such a torrent go `missing`.
 *
 * WHY BOTH ARMS SURVIVE NOW THAT EVERY ENGINE HAS THE PICKERS. The union used to exist because half
 * the engines had no picker and handed over `File` objects from an `<input>` instead. It exists now
 * for the WORKER BOUNDARY. Where an engine has no picker, `@banou/ponyfill` wraps the input's files
 * in handles, and those wrappers deliberately refuse `structuredClone`, so they cannot cross a
 * `postMessage` any more than they can be stored. The page resolves them to the `File` behind each
 * one before posting, and this is the type that carries the result. See `use-create-torrent.ts`.
 */
export type SourceRef = FileSystemFileHandle | File

/** A fresh `File` from either kind of reference. */
export const fileFrom = (ref: SourceRef): Promise<File> =>
  typeof (ref as FileSystemFileHandle).getFile === 'function'
    ? (ref as FileSystemFileHandle).getFile()
    : Promise.resolve(ref as File)

export type PickedFile = SourceFile & {
  handle: SourceRef
  /**
   * Read at walk time and checked again after hashing.
   *
   * A file edited between the two is a torrent whose pieces describe a mixture of two versions, and
   * nothing downstream would notice: the hashes are self-consistent, so it publishes cleanly and
   * then fails every piece a peer asks for.
   */
  lastModified: number
}

export type WalkResult = {
  files: PickedFile[]
  /** What was left out, so the dialog can say so rather than quietly shrinking the torrent. */
  skipped: string[]
  /** True when MAX_FILES stopped the walk, so `files` is not the whole of what was picked. */
  truncated: boolean
}

export type WalkOptions = {
  signal?: AbortSignal
  /** Called as the walk goes, for a count that moves while a large tree is being read. */
  onFound?: (found: number) => void
}

type DirectoryEntries = FileSystemDirectoryHandle & {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
}

export class WalkCancelled extends Error {
  constructor() {
    super('reading the folder was cancelled')
    this.name = 'WalkCancelled'
  }
}

/**
 * Every file under `root`, with its path relative to `root`.
 *
 * Relative to the picked directory, NOT including the directory's own name. The torrent's `name`
 * carries that, and a multi-file info dict's `path` lists are relative to the name, so this is
 * already the shape the metainfo wants. It is also why a read can be served straight from the
 * handles here: the source handle IS the directory the name refers to.
 *
 * Sorted by `plan()` rather than here. The order that ends up in the torrent is the one that fixes
 * every file's offset, so it belongs with the rest of the metainfo rules where it is tested, not
 * with whatever order the platform happens to iterate in.
 */
export const walkDirectory = async (
  root: FileSystemDirectoryHandle,
  { signal, onFound }: WalkOptions = {},
): Promise<WalkResult> => {
  const files: PickedFile[] = []
  const skipped: string[] = []
  let truncated = false

  const visit = async (dir: FileSystemDirectoryHandle, prefix: string[]): Promise<void> => {
    if (signal?.aborted) throw new WalkCancelled()
    if (truncated) return
    if (prefix.length >= MAX_DEPTH) {
      skipped.push(`${prefix.join('/')} (nested too deep)`)
      return
    }
    const entries = (dir as DirectoryEntries).entries
    if (!entries) throw new Error('this browser cannot list a picked folder')

    for await (const [name, handle] of entries.call(dir)) {
      if (signal?.aborted) throw new WalkCancelled()
      if (files.length >= MAX_FILES) { truncated = true; return }
      const path = [...prefix, name]
      if (handle.kind === 'directory') {
        await visit(handle as FileSystemDirectoryHandle, path)
        if (truncated) return
        continue
      }
      if (isJunk(name)) { skipped.push(path.join('/')); continue }
      const fileHandle = handle as FileSystemFileHandle
      // getFile() is what actually reads a size, and it is also the first thing that fails on a
      // cloud placeholder or a file the grant does not really cover. Skipping with a reason beats
      // failing the whole walk over one unreadable entry.
      const file = await fileHandle.getFile().catch(() => null)
      if (!file) { skipped.push(`${path.join('/')} (could not be read)`); continue }
      files.push({ path, size: file.size, lastModified: file.lastModified, handle: fileHandle })
      onFound?.(files.length)
    }
  }

  await visit(root, [])
  return { files, skipped, truncated }
}

/** The single-file case: a picked file is its own torrent, named after itself. */
export const pickedFile = async (handle: SourceRef): Promise<PickedFile> => {
  const file = await fileFrom(handle)
  return { path: [handle.name], size: file.size, lastModified: file.lastModified, handle }
}

/**
 * Reads one file's bytes, for the hashing pass.
 *
 * A fresh `getFile()` per read on purpose, matching `hybrid-storage.ts`, which measured that holding
 * a `File` between reads bought nothing and noted that a `File` is a snapshot which throws once the
 * file changes underneath. Here that throw is wanted: it is the earliest report that the source
 * moved while it was being read.
 */
export const readPicked = async (file: PickedFile, offset: number, length: number): Promise<Uint8Array> => {
  const blob = await fileFrom(file.handle)
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
}

export type Staleness = { path: string, was: number, now: number }

/**
 * Which files changed since the walk, checked after hashing and before publishing anything.
 *
 * The pieces are self-consistent whatever happened, so a torrent built over an edit publishes
 * cleanly and then fails every piece a peer asks for. This is the only point at which that is
 * cheap to catch: two numbers per file, no reading.
 *
 * INERT on the File route, by construction rather than by oversight. A `File` from an input is a
 * snapshot, so its `size` and `lastModified` are the numbers captured at pick time and can never
 * disagree with themselves. What still catches an edit there is the read itself: slicing a snapshot
 * whose backing file has moved rejects, which `readPicked` surfaces at the point it happens.
 */
export const changedSince = async (files: PickedFile[]): Promise<Staleness[]> => {
  const changed: Staleness[] = []
  for (const file of files) {
    const now = await fileFrom(file.handle).catch(() => null)
    if (!now) { changed.push({ path: file.path.join('/'), was: file.size, now: -1 }); continue }
    if (now.size !== file.size || now.lastModified !== file.lastModified) {
      changed.push({ path: file.path.join('/'), was: file.size, now: now.size })
    }
  }
  return changed
}
