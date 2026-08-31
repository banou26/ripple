/**
 * Removing torrent payload the library no longer has a record of.
 *
 * The list is the record. Anything under the save root that no entry accounts for is data nothing
 * in the product can ever show, restart, export or reclaim, and it counts against the origin's
 * budget forever: `remove-missing` on a ghost row drops the entry and leaves the bytes, and a
 * `clear-list` from an account switch used to drop every entry at once.
 *
 * Scope is deliberately the SAVE ROOT and nothing above it. `@fkn/lib` exposes a general OPFS
 * filesystem rooted at the origin root, so a sweep that deleted whatever it did not recognise there
 * would be deleting another subsystem's files. The only thing outside the save root this touches is
 * the engine's own leftover probe files, matched by a name Ripple picked.
 */

/**
 * Every shape of torrent id `savePathFor` writes: 40 hex for v1, 64 for v2, 32 base32 for a v1
 * infohash that arrived base32 encoded.
 *
 * Exported so `magnet.ts` can assert that what it produces is a name this recognises, because the
 * two have to agree and twice they did not. Both failures were the same one and both lost data: an
 * id this does not recognise is not a hash directory, so it falls through to the catch-all and the
 * torrent's whole save directory is deleted about a minute after the page loads, while the library
 * goes on listing it.
 *
 *  - a v2 magnet's id kept its `1220` multihash prefix and came to 68 characters;
 *  - a base32 `btih` magnet, which is ordinary and which `magnet-codec.test.ts` has always carried a
 *    case for, gives 32 characters of `[a-z2-7]` and matched nothing here either.
 *
 * The base32 form is ACCEPTED rather than normalised to hex. Normalising would be tidier and would
 * change the id of every torrent already added that way, orphaning the bytes it currently points at,
 * which is the one outcome this whole comment is about.
 */
export const TORRENT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[a-z2-7]{32})$/i
const HEX_ID = TORRENT_ID_PATTERN

/** Left by `opfsAvailable` when a tab dies between opening the probe and removing it. */
export const PROBE_PREFIX = '.ripple-probe-'

export type DirEntry = { name: string, kind: 'file' | 'directory' }

export type SweepInput = {
  /** Direct children of the save root. */
  entries: DirEntry[]
  /** Every infoHash the library knows, lowercased, plus every one currently in the session. */
  listedHashes: Set<string>
  /** Top-level names under the save root that a known torrent is using. */
  claimedNames: Set<string>
  /**
   * Whether every torrent still rooted at the SHARED save path could be accounted for.
   *
   * A torrent with its own `/dl/<infoHash>` directory is attributable by name alone. One rooted at
   * the shared path is not: its entries are named by the torrent's own file paths, so a release
   * folder is indistinguishable from an orphan unless some known torrent claims it. When even one
   * of those cannot be accounted for, everything that is not a hash directory is left alone.
   */
  attributable: boolean
}

/** Which direct children of the save root belong to nothing. */
export const planSweep = ({ entries, listedHashes, claimedNames, attributable }: SweepInput): string[] =>
  entries
    .filter(({ name, kind }) => {
      // a claim always wins, including over the hash rule: a release folder may be NAMED like a hash
      if (claimedNames.has(name)) return false
      if (kind === 'directory' && HEX_ID.test(name)) return !listedHashes.has(name.toLowerCase())
      return attributable
    })
    .map(({ name }) => name)

const childrenOf = async (dir: FileSystemDirectoryHandle): Promise<DirEntry[]> => {
  const out: DirEntry[] = []
  for await (const handle of (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
    out.push({ name: handle.name, kind: handle.kind })
  }
  return out
}

const descend = async (root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle | null> => {
  let dir: FileSystemDirectoryHandle | null = root
  for (const segment of path.split('/').filter(Boolean)) {
    dir = dir ? await dir.getDirectoryHandle(segment).catch(() => null) : null
  }
  return dir
}

/**
 * Delete everything under `saveRoot` that nothing accounts for. Returns the names removed.
 *
 * A removal that fails is swallowed: the usual reason is a sync access handle the engine still
 * holds, and the next pass will find the same entry and try again.
 */
export const sweepSaveRoot = async (
  root: FileSystemDirectoryHandle,
  saveRoot: string,
  input: Omit<SweepInput, 'entries'>,
): Promise<string[]> => {
  const dir = await descend(root, saveRoot)
  if (!dir) return []
  const removed: string[] = []
  for (const name of planSweep({ ...input, entries: await childrenOf(dir) })) {
    try {
      await dir.removeEntry(name, { recursive: true })
      removed.push(name)
    } catch { /* still held open, or already gone */ }
  }
  return removed
}

/** Probe files a previous run never got to clean up. Matched by name, never by "not recognised". */
export const sweepProbes = async (root: FileSystemDirectoryHandle): Promise<number> => {
  let removed = 0
  for (const { name, kind } of await childrenOf(root)) {
    if (kind !== 'file' || !name.startsWith(PROBE_PREFIX)) continue
    if (await root.removeEntry(name).then(() => true, () => false)) removed++
  }
  return removed
}
