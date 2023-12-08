import { makeCallListener, registerListener } from 'osra'

const opfsRoot = await navigator.storage.getDirectory()
const torrentFolderHandle = await opfsRoot.getDirectoryHandle('torrents', { create: true })

const getFileHandleSyncAccessHandle = async (fileHandle: FileSystemFileHandle, tryCount = 0) =>
  fileHandle
    .createSyncAccessHandle()
    .catch(async err => {
      if (tryCount > 20) throw err
      await new Promise((resolve) => setTimeout(resolve, 100))
      return getFileHandleSyncAccessHandle(fileHandle, tryCount + 1)
    })

const writeFileAccessHandles = new Map<string, FileSystemFileHandle>()

const { resolvers } = registerListener({
  resolvers: {
    ping: makeCallListener(async () => {
      return 'pong'
    }),
    openWriteStream: makeCallListener(async ({ filePath, offset = 0, size }: { filePath: string, offset: number, size: number }) => {
      let _offset = offset
      const folderHandle =
        await filePath
          .split('/')
          .slice(0, -1)
          .reduce(
            async (parentHandlePromise, path) =>
              (await parentHandlePromise).getDirectoryHandle(path, { create: true }),
            Promise.resolve(torrentFolderHandle)
          )
      const fileHandle = await folderHandle.getFileHandle(filePath.split('/').slice(-1)[0], { create: true })
      const file = await fileHandle.getFile()
      const writable = await getFileHandleSyncAccessHandle(fileHandle)
      writeFileAccessHandles.set(filePath, writable)

      if (size !== file.size) await writable.truncate(size)

      return {
        seek: async (offset: number) => {
          _offset = offset
        },
        write: async (buffer: ArrayBuffer) => {
          await writable.write(buffer, { at: _offset })
          _offset += buffer.byteLength
        },
        close: async () => {
          writeFileAccessHandles.delete(filePath)
          await writable.close()
        }
      }
    }),
    readTorrentFile: makeCallListener(async ({ infoHash, filePath, offset, size }: { infoHash: string, filePath: string, offset: number, size: number }) => {
      const folderHandle =
        await filePath
          .split('/')
          .slice(0, -1)
          .reduce(
            async (parentHandlePromise, path) =>
              (await parentHandlePromise).getDirectoryHandle(path),
            Promise.resolve(await torrentFolderHandle.getDirectoryHandle(infoHash))
          )
      const fileHandle = await folderHandle.getFileHandle(filePath)
      const foundWriteFileAccessHandle = writeFileAccessHandles.get(`torrents/${infoHash}/${filePath}`)
      const accessHandle = foundWriteFileAccessHandle ?? await getFileHandleSyncAccessHandle(fileHandle)
      const buffer = new ArrayBuffer(size)
      await accessHandle.read(buffer, { at: offset })
      if (!foundWriteFileAccessHandle) await accessHandle.close()
      return buffer
    })
  },
  target: globalThis as unknown as Worker,
  key: 'io-worker'
})

export type Resolvers = typeof resolvers
