// The chunked storage in a real worker, where OPFS hands out sync access handles.
import { createChunkedStorage } from '../../src/torrent/chunked-storage'

const C = 4 * 1024 * 1024
const SAVE_PATH = '/cache/' + 'e'.repeat(40)

const usage = async () => (await navigator.storage.estimate()).usage ?? 0

/** Poll until usage falls under `below`, or give up after two seconds. */
const settledUnder = async (below: number) => {
  for (let waited = 0; waited < 2_000; waited += 20) {
    const now = await usage()
    if (now < below) return now
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return usage()
}

self.onmessage = async () => {
  try {
    const root = await navigator.storage.getDirectory()
    const store = createChunkedStorage(C)
    await store.onNewStorage(1, SAVE_PATH, [{ path: 'film.mkv', size: 64 * C }])

    const base = await usage()
    // eight bytes at the end of chunk 40
    await store.write(1, 0, 41 * C - 8, new Uint8Array(8).fill(7))
    const chunked = await usage()
    await store.drop(SAVE_PATH, 0, 40)
    const dropped = await settledUnder(chunked - C / 2)

    // THE CONTROL: the same write into one file the length of the torrent's file
    const file = await root.getFileHandle('control.bin', { create: true })
    const plain = await (file as unknown as { createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle()
    const before = await usage()
    plain.write(new Uint8Array(8).fill(7), { at: 41 * C - 8 })
    plain.flush()
    const whole = await usage()
    plain.close()
    await root.removeEntry('control.bin')
    await store.deleteFiles?.(1, 0)

    postMessage({ base, chunked, dropped, before, whole })
  } catch (error) {
    postMessage({ error: String(error) })
  }
}
