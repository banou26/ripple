import type { TorrentClient } from './client'
import type { Torrent } from './types'

const CHUNK = 8 * 1024 * 1024

// What a "this file is already there" check reads from each side before it believes it. Five windows
// rather than one, because a truncated or partially rewritten file matches at the head and differs
// nowhere near it, and the tail is where an interrupted writer leaves its mark.
const PROBE_WINDOW = 16 * 1024
const PROBE_AT = [0, 0.25, 0.5, 0.75, 1]

const fileHandleAt = async (root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()!
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir.getFileHandle(name, { create: true })
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** the windows to compare, clamped into the file and deduplicated, smallest offset first */
export const probeRanges = (size: number, window = PROBE_WINDOW): { offset: number, length: number }[] => {
  if (size <= 0) return []
  if (size <= window * PROBE_AT.length) return [{ offset: 0, length: size }]
  const offsets = new Set(PROBE_AT.map(at => Math.min(Math.max(0, Math.round((size - window) * at)), size - window)))
  return [...offsets].sort((a, b) => a - b).map(offset => ({ offset, length: window }))
}

/**
 * Is the file already in the folder the file this torrent would write?
 *
 * The size alone used to be the whole answer, and it is not one. A file of the right name and the
 * right length that the person already had, or that another torrent wrote, satisfied it with nothing
 * copied, and the app then reported the torrent as saved to their folder. That is not a cosmetic
 * mistake: being saved is what unlocks "Remove and delete Ripple's copy", so the one action that
 * deletes the only copy was reachable on the strength of a matching byte count.
 *
 * Sampled rather than hashed, deliberately. `crypto.subtle.digest` takes one buffer and has no
 * streaming form, so digesting both sides of a multi-gigabyte video means holding it in memory. Five
 * windows is bounded work that separates a different file of the same length from the real one, and
 * it fails in the safe direction: anything it cannot read, it treats as not matching, and the file is
 * copied again.
 */
const alreadyThere = async (
  client: TorrentClient,
  torrent: Torrent,
  index: number,
  handle: FileSystemFileHandle,
  size: number,
): Promise<boolean> => {
  const native = await handle.getFile()
  if (native.size !== size) return false
  if (size === 0) return true
  for (const { offset, length } of probeRanges(size)) {
    // `prioritize: false`, since a torrent only reaches the mirror once it is complete and nothing
    // here should be reordering the pieces of anything that is not
    const [mine, theirs] = await Promise.all([
      client.read(Number(torrent.id), index, offset, length, false),
      native.slice(offset, offset + length).arrayBuffer(),
    ])
    if (!sameBytes(mine, new Uint8Array(theirs))) return false
  }
  return true
}

/**
 * Copy every file of a finished torrent into the folder the user granted.
 *
 * Resolving means every file is present AND its content was checked, which is what the caller turns
 * into "saved to your folder". Returns how many files it had to write, so a copy that found
 * everything already in place can stay quiet.
 */
export const syncTorrentToDirectory = async (
  client: TorrentClient,
  torrent: Torrent,
  root: FileSystemDirectoryHandle,
): Promise<number> => {
  let written = 0
  for (const [index, file] of (torrent.files ?? []).entries()) {
    const handle = await fileHandleAt(root, file.name)
    if (await alreadyThere(client, torrent, index, handle, file.size)) continue
    const writable = await handle.createWritable()
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        const len = Math.min(CHUNK, file.size - offset)
        const chunk = await client.read(Number(torrent.id), index, offset, len)
        await writable.write(chunk as Uint8Array<ArrayBuffer>)
      }
      await writable.close()
      written++
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
  }
  return written
}
