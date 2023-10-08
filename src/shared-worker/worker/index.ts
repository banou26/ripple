console.log('shared worker\'s worker')


const opfsRoot = await navigator.storage.getDirectory()
const fileHandle = await opfsRoot.getFileHandle('test', { create: true })
console.log('fileHandle', fileHandle)
const syncAccessHandle = await fileHandle.createSyncAccessHandle()
console.log('syncAccessHandle', syncAccessHandle)
syncAccessHandle.write(new Uint8Array([1, 2, 3, 4, 5]))
// const writable = await fileHandle.createWritable()
// console.log('writable', writable)

export {}