// Reads through the worker's Session.read(): the worker owns the OPFS SyncAccessHandle,
// so an export never races the seeding write lock.

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

// MUST be called synchronously from the click handler, so showSaveFilePicker still has the gesture
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
    // copied rather than kept: a caller may hand over a view it still owns
    write: async (c) => { parts.push(c.slice()) },
    close: async () => triggerAnchorDownload(new Blob(parts as BlobPart[]), baseName),
    abort: async () => {},
  }
}

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
