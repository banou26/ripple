

const opfsRoot = await navigator.storage.getDirectory()


export const writeStream = async (
  { buffer, infoHash, length, offset, path }:
  { infoHash: string, path: string, offset: number, length: number, buffer: ArrayBuffer }
) => {
  const fileHandle = await opfsRoot.getFileHandle(infoHash, { create: true })
  const syncAccessHandle = await fileHandle.createSyncAccessHandle()
  const writable = await fileHandle.createWritable()
  await writable.write(buffer)
  await writable.close()
}

export {

}
