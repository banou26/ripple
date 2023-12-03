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

const { resolvers } = registerListener({
  resolvers: {
    ping: makeCallListener(async () => {
      return 'pong'
    }),
    openWriteStream: makeCallListener(async ({ filePath, offset = 0, size }: { filePath: string, offset: number, size: number }) => {
      let _offset = offset
      const folderHande = await torrentFolderHandle.getDirectoryHandle(filePath.split('/').slice(1, -1).join('/'), { create: true })
      const fileHandle = await folderHande.getFileHandle(filePath.split('/').slice(-1)[0], { create: true })
      const file = await fileHandle.getFile()
      const writable = await getFileHandleSyncAccessHandle(fileHandle)

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
          await writable.close()
        }
      }
    }),
    readTorrentFile: makeCallListener(async ({ infoHash, filePath, offset, size }: { infoHash: string, filePath: string, offset: number, size: number }) => {
      const folderHandle = await torrentFolderHandle.getDirectoryHandle(infoHash)
      const fileHandle = await folderHandle.getFileHandle(filePath)
      const accessHandle  = await fileHandle.createSyncAccessHandle()
      const buffer = new ArrayBuffer(size)
      await accessHandle.read(buffer, { at: offset })
      await accessHandle.close()
      return buffer
    })
  },
  target: globalThis as unknown as Worker,
  key: 'io-worker'
})

export type Resolvers = typeof resolvers
