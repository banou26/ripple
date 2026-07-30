// Export a finished file out of OPFS to the user's real disk. Reads through the
// worker's Session.read() (the worker owns the OPFS SyncAccessHandle, so this
// never races the seeding write lock) and streams it straight out, so the size of
// an export is never the size of the memory it needs.

import type { TorrentClient } from './client'
import type { TorrentFile } from './types'
import type { Sink } from './stream-download'
import { openStreamSink } from './stream-download'
import { writeZip } from './zip'

const CHUNK = 8 * 1024 * 1024

const triggerAnchorDownload = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Three ways to write a file out, in descending order of how well they scale:
//
//   showSaveFilePicker  true streaming into a file the user names. Chromium only.
//   the service worker  true streaming, as an ordinary browser download, everywhere else.
//   a Blob              the whole export held in memory, which a large torrent will not
//                       survive. Only reached with no service worker at all.
//
// MUST be called synchronously from the click handler so the user gesture is
// still live when showSaveFilePicker runs. `size` is passed only when it is known
// exactly, so the browser's own download UI can show a real percentage.
const openSink = async (baseName: string, size = 0): Promise<Sink> => {
  const picker = (window as any).showSaveFilePicker as undefined | ((o: any) => Promise<any>)
  if (picker) {
    const handle = await picker({ suggestedName: baseName })
    const writable = await handle.createWritable()
    return {
      write: (c) => writable.write(c),
      close: () => writable.close(),
      abort: () => writable.abort?.().catch(() => {}),
    }
  }
  const streamed = await openStreamSink(baseName, size)
  if (streamed) return streamed
  const parts: Uint8Array[] = []
  return {
    // Copied rather than kept: a caller may hand over a view it still owns.
    write: async (c) => { parts.push(c.slice()) },
    close: async () => triggerAnchorDownload(new Blob(parts as BlobPart[]), baseName),
    abort: async () => {},
  }
}

// Zip every file of a multifile torrent into a single download, preserving the
// torrent's relative paths. STORE only, so it streams at read speed with no
// compression buffering; sizes come straight from the torrent metadata.
export const saveTorrentAsZipToDisk = async (
  client: TorrentClient,
  handle: number,
  torrentName: string,
  files: TorrentFile[],
  onProgress?: (fraction: number) => void,
): Promise<void> => {
  const baseName = (torrentName.replace(/[/\\]/g, '_') || 'torrent') + '.zip'
  const sink = await openSink(baseName)
  try {
    await writeZip(
      files.map((f, index) => ({
        path: f.name,
        size: f.size,
        read: (offset: number, len: number) => client.read(handle, index, offset, len),
      })),
      sink.write,
      onProgress,
    )
    await sink.close()
  } catch (e) {
    await sink.abort()
    throw e
  }
}

export const saveTorrentFileToDisk = async (
  client: TorrentClient,
  handle: number,
  fileIndex: number,
  filePath: string,
  fileBytes: number,
  onProgress?: (fraction: number) => void,
): Promise<void> => {
  const baseName = filePath.split('/').pop() || 'download'
  const sink = await openSink(baseName, fileBytes)
  try {
    for (let offset = 0; offset < fileBytes; offset += CHUNK) {
      const len = Math.min(CHUNK, fileBytes - offset)
      const chunk = await client.read(handle, fileIndex, offset, len)
      await sink.write(chunk)
      onProgress?.((offset + len) / fileBytes)
    }
    await sink.close()
  } catch (e) {
    await sink.abort()
    throw e
  }
}
