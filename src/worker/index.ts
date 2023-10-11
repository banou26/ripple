import { makeCallListener, registerListener } from 'osra'

console.log('IO worker')

globalThis.addEventListener('message', (ev) => {
  console.log('ev', ev)
})

const opfsRoot = await navigator.storage.getDirectory()
const torrentFolderHandle = await opfsRoot.getDirectoryHandle('torrents', { create: true })

const { resolvers } = registerListener({
  resolvers: {
    openWriteStream: makeCallListener(async ({ filePath, offset = 0, size }: { filePath: string, offset: number, size: number }) => {
      console.log('openWriteStream', filePath, offset, size)
      const folderHande = await torrentFolderHandle.getDirectoryHandle(filePath.split('/').slice(1, -1).join('/'), { create: true })
      const fileHandle = await folderHande.getFileHandle(filePath.split('/').slice(-1)[0], { create: true })
      const file = await fileHandle.getFile()
      // const syncAccessHandle = await fileHandle.createSyncAccessHandle()
      const writable = await fileHandle.createWritable({ keepExistingData: true })

      if (size !== file.size) await writable.truncate(size)
      if (offset) await writable.seek(offset)
      
      return {
        seek: async (offset: number) => {
          await writable.seek(offset)
        },
        write: async (buffer: ArrayBuffer) => {
          await writable.write(buffer)
        },
        close: async () => {
          await writable.close()
        }
      }
    })
  },
  target: globalThis as unknown as Worker,
  key: 'io-worker'
})

export type Resolvers = typeof resolvers
