// import { get } from 'idb-keyval'

// const folderHandle = await get('file-system-access-handle')

// console.log('folderHandle', folderHandle)

// // const root = await navigator.storage.getDirectory();
// // Create a new file handle.

// const fileHandle = await folderHandle.getFileHandle('Untitled.txt', { create: true })
// console.log('fileHandle', fileHandle)
// // Create a new directory handle.

// // const dirHandle = await folderHandle.getDirectoryHandle('New Folder', { create: true })
// // console.log('dirHandle', dirHandle)

// // const accessHandle = await fileHandle.createSyncAccessHandle()
// // console.log('accessHandle', accessHandle)


// // const writtenBytes = accessHandle.write(buffer)
// // const readBytes = accessHandle.read(buffer, { at: 1 })


// const opfsRoot = await navigator.storage.getDirectory()
// const fileHandle = await opfsRoot.getFileHandle('test', { create: true })
// console.log('fileHandle', fileHandle)
// const syncAccessHandle = await fileHandle.createSyncAccessHandle()
// const writable = await fileHandle.createWritable()

// export {}


// import WorkerUrl from './worker?worker&url'

// const worker = new Worker(WorkerUrl, { type: 'module' })
// console.log('worker', worker)


console.log('test')