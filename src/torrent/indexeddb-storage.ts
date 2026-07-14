import type { StorageBackend } from 'libtorrent-wasm/types'

type FileMeta = { path: string, size: number }
type StorageEntry = { namespace: string, files: FileMeta[] }
type CachedBlock = { key: IDBValidKey, bytes: Uint8Array, version: number }
type BlockSlice = { key: IDBValidKey, cacheKey: string, blockIndex: number }

const BLOCK_SIZE = 16 * 1024
const DB_NAME = 'ripple:torrent-data'
const STORE_NAME = 'blocks'

let database: Promise<IDBDatabase> | undefined

const openDatabase = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
})

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const asBlock = (value: unknown) => {
  const block = new Uint8Array(BLOCK_SIZE)
  if (value instanceof ArrayBuffer) block.set(new Uint8Array(value).subarray(0, BLOCK_SIZE))
  else if (ArrayBuffer.isView(value)) block.set(new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, BLOCK_SIZE)))
  return block
}

export class IndexedDBStorage implements StorageBackend {
  private storages = new Map<number, StorageEntry>()
  private dirty = new Map<string, CachedBlock>()
  private pending = new Map<string, Promise<void>>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> | undefined
  private flushError: unknown

  async ready() {
    await openDatabase()
  }

  async onNewStorage(id: number, savePath: string, files: FileMeta[]) {
    this.storages.set(id, { namespace: savePath.replace(/^\/+/, ''), files })
    await openDatabase()
  }

  async onRemoveStorage(id: number) {
    await this.flush()
    this.storages.delete(id)
  }

  read(id: number, fileIndex: number, offset: number, len: number): Uint8Array | Promise<Uint8Array> {
    this.checkFlush()
    const entry = this.entry(id, fileIndex)
    const output = new Uint8Array(len)
    if (len === 0) return output
    const slices = this.slices(entry, fileIndex, offset, len)
    if (slices.every(({ cacheKey }) => this.dirty.has(cacheKey))) {
      this.copyRead(output, offset, len, slices.map(({ cacheKey }) => this.dirty.get(cacheKey)!.bytes), slices)
      return output
    }
    return this.readSlow(output, offset, len, slices)
  }

  write(id: number, fileIndex: number, offset: number, bytes: Uint8Array): void | Promise<void> {
    this.checkFlush()
    const entry = this.entry(id, fileIndex)
    if (bytes.byteLength === 0) return
    const operations: Promise<void>[] = []
    for (const slice of this.slices(entry, fileIndex, offset, bytes.byteLength)) {
      const blockStart = slice.blockIndex * BLOCK_SIZE
      const targetStart = Math.max(offset, blockStart) - blockStart
      const sourceStart = Math.max(blockStart, offset) - offset
      const length = Math.min(offset + bytes.byteLength, blockStart + BLOCK_SIZE) - Math.max(offset, blockStart)
      const update = (block: Uint8Array) => block.set(bytes.subarray(sourceStart, sourceStart + length), targetStart)
      const cached = this.dirty.get(slice.cacheKey)
      const pending = this.pending.get(slice.cacheKey)
      if (!pending && (cached || (targetStart === 0 && length === BLOCK_SIZE))) {
        const block = cached ? cached.bytes.slice() : new Uint8Array(BLOCK_SIZE)
        update(block)
        this.markDirty(slice, block)
      } else {
        operations.push(this.queueUpdate(slice, update, targetStart === 0 && length === BLOCK_SIZE))
      }
    }
    if (operations.length) return Promise.all(operations).then(() => {})
  }

  async deleteFiles(id: number) {
    const entry = this.storages.get(id)
    if (!entry) return
    await Promise.allSettled(this.pending.values())
    this.dropDirty(entry)
    await this.flushing?.catch(() => {})
    this.dropDirty(entry)
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(STORE_NAME)
    entry.files.forEach((file, fileIndex) => {
      const range = IDBKeyRange.bound(
        [entry.namespace, file.path, fileIndex, 0],
        [entry.namespace, file.path, fileIndex, Number.MAX_SAFE_INTEGER],
      )
      const request = store.openKeyCursor(range)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        store.delete(cursor.primaryKey)
        cursor.continue()
      }
    })
    await done
    this.flushError = undefined
    if (this.dirty.size && !this.flushTimer) this.flushTimer = setTimeout(() => { this.flush().catch(() => {}) }, 10)
  }

  async check() { return 0 }
  async release() { await this.flush() }
  async stop() { await this.flush() }

  private async readSlow(output: Uint8Array, offset: number, len: number, slices: BlockSlice[]) {
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(STORE_NAME)
    const requests = slices.map(({ key, cacheKey }) => {
      const cached = this.dirty.get(cacheKey)
      return cached ? Promise.resolve(cached.bytes) : requestResult(store.get(key)).then(asBlock)
    })
    const [blocks] = await Promise.all([Promise.all(requests), done])
    this.copyRead(output, offset, len, blocks, slices)
    return output
  }

  private copyRead(output: Uint8Array, offset: number, len: number, blocks: Uint8Array[], slices: BlockSlice[]) {
    slices.forEach(({ blockIndex }, index) => {
      const block = blocks[index]!
      const blockStart = blockIndex * BLOCK_SIZE
      const sourceStart = Math.max(offset, blockStart) - blockStart
      const sourceEnd = Math.min(offset + len, blockStart + BLOCK_SIZE) - blockStart
      output.set(block.subarray(sourceStart, sourceEnd), blockStart + sourceStart - offset)
    })
  }

  private queueUpdate(slice: BlockSlice, update: (block: Uint8Array) => void, overwrite: boolean) {
    const previous = this.pending.get(slice.cacheKey) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const cached = this.dirty.get(slice.cacheKey)
      const block = cached ? cached.bytes.slice() : overwrite ? new Uint8Array(BLOCK_SIZE) : await this.load(slice.key)
      update(block)
      this.markDirty(slice, block)
    })
    this.pending.set(slice.cacheKey, operation)
    const cleanup = () => {
      if (this.pending.get(slice.cacheKey) === operation) this.pending.delete(slice.cacheKey)
    }
    operation.then(cleanup, cleanup)
    return operation
  }

  private async load(key: IDBValidKey) {
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const done = transactionDone(transaction)
    const [value] = await Promise.all([requestResult(transaction.objectStore(STORE_NAME).get(key)), done])
    return asBlock(value)
  }

  private markDirty(slice: BlockSlice, bytes: Uint8Array) {
    const version = (this.dirty.get(slice.cacheKey)?.version ?? 0) + 1
    this.dirty.set(slice.cacheKey, { key: slice.key, bytes, version })
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flush().catch(() => {}) }, 10)
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (!this.flushing) {
      this.flushing = this.flushAll()
        .then(() => { this.flushError = undefined })
        .catch((error) => { this.flushError = error; throw error })
        .finally(() => {
          this.flushing = undefined
          if (this.dirty.size && !this.flushError) this.flushTimer = setTimeout(() => { this.flush().catch(() => {}) }, 10)
        })
    }
    return this.flushing
  }

  private async flushAll() {
    do await this.flushOnce()
    while (this.pending.size || this.dirty.size)
  }

  private async flushOnce() {
    await Promise.all(this.pending.values())
    const batch = [...this.dirty.entries()]
    if (!batch.length) return
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(STORE_NAME)
    for (const [, block] of batch) store.put(block.bytes.buffer, block.key)
    await done
    for (const [cacheKey, block] of batch) {
      if (this.dirty.get(cacheKey)?.version === block.version) this.dirty.delete(cacheKey)
    }
  }

  private checkFlush() {
    if (this.flushError) throw this.flushError
  }

  private dropDirty(entry: StorageEntry) {
    for (const [cacheKey, block] of this.dirty) {
      const key = block.key as IDBValidKey[]
      const fileIndex = key[2]
      if (key[0] === entry.namespace && typeof fileIndex === 'number' && key[1] === entry.files[fileIndex]?.path) {
        this.dirty.delete(cacheKey)
      }
    }
  }

  private entry(id: number, fileIndex: number) {
    const entry = this.storages.get(id)
    if (!entry) throw new Error(`unknown storage ${id}`)
    if (!entry.files[fileIndex]) throw new Error(`unknown file ${fileIndex}`)
    return entry
  }

  private key(entry: StorageEntry, fileIndex: number, blockIndex: number): IDBValidKey {
    return [entry.namespace, entry.files[fileIndex]!.path, fileIndex, blockIndex]
  }

  private slices(entry: StorageEntry, fileIndex: number, offset: number, len: number): BlockSlice[] {
    const firstBlock = Math.floor(offset / BLOCK_SIZE)
    const lastBlock = Math.floor((offset + len - 1) / BLOCK_SIZE)
    const slices: BlockSlice[] = []
    for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
      const key = this.key(entry, fileIndex, blockIndex)
      slices.push({ key, cacheKey: JSON.stringify(key), blockIndex })
    }
    return slices
  }
}
