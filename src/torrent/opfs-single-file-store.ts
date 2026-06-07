// abstract-chunk-store backed by ONE OPFS file per torrent (vs fsa-chunk-store,
// which shards a file per piece). Chunk `index` lives at `index * chunkLength`
// in a single FileSystemSyncAccessHandle (sync + fast, Worker-only). WebTorrent
// reads byte ranges through this via its File API, so playback is unaffected.

type Cb<T = void> = (err: Error | null, value?: T) => void
const noop: Cb<any> = () => {}

type StoreOpts = {
  length?: number
  name?: string
}

export class OPFSSingleFileStore {
  chunkLength: number
  length: number
  lastChunkLength: number
  lastChunkIndex: number
  name: string

  private handle: Promise<FileSystemSyncAccessHandle>
  private closed = false

  constructor(chunkLength: number, opts: StoreOpts = {}) {
    this.chunkLength = Number(chunkLength)
    if (!this.chunkLength) throw new Error('First argument must be a chunk length')
    if (!globalThis.navigator?.storage?.getDirectory) throw new Error('OPFS not supported')

    this.length = Number(opts.length) || Infinity
    if (this.length !== Infinity) {
      this.lastChunkLength = this.length % this.chunkLength || this.chunkLength
      this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1
    } else {
      this.lastChunkLength = this.chunkLength
      this.lastChunkIndex = Infinity
    }

    // One file, named after the torrent. OPFS file names can't contain slashes.
    const name = (opts.name || crypto.randomUUID()).replace(/[/\\]/g, '_')
    this.name = name
    this.handle = (async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('wt', { create: true })
      const fh = await dir.getFileHandle(name, { create: true })
      return (fh as any).createSyncAccessHandle() as Promise<FileSystemSyncAccessHandle>
    })()
  }

  put(index: number, buf: Uint8Array, cb: Cb = noop) {
    this.handle.then((h) => {
      try {
        h.write(buf, { at: index * this.chunkLength })
        h.flush()
        cb(null)
      } catch (e) { cb(e as Error) }
    }, (e) => cb(e as Error))
  }

  get(index: number, opts: { offset?: number, length?: number } | Cb<Uint8Array> | null, cb: Cb<Uint8Array> = noop) {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    const o = (opts as { offset?: number, length?: number }) || {}
    const isLast = index === this.lastChunkIndex
    const chunkLength = isLast ? this.lastChunkLength : this.chunkLength
    const from = o.offset || 0
    const len = o.length != null ? o.length : chunkLength - from
    if (len === 0) { cb(null, new Uint8Array(0)); return }
    this.handle.then((h) => {
      try {
        const out = new Uint8Array(len)
        const read = h.read(out, { at: index * this.chunkLength + from })
        // Unwritten region of a fresh/sparse file ⇒ the chunk isn't there yet.
        if (read === 0) { cb(new Error(`Chunk ${index} does not exist`)); return }
        cb(null, read < len ? out.subarray(0, read) : out)
      } catch (e) { cb(e as Error) }
    }, (e) => cb(e as Error))
  }

  close(cb: Cb = noop) {
    if (this.closed) { cb(null); return }
    this.closed = true
    this.handle.then((h) => { try { h.flush(); h.close() } catch {} cb(null) }, () => cb(null))
  }

  destroy(cb: Cb = noop) {
    this.close(() => {
      ;(async () => {
        try {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('wt', { create: true })
          await dir.removeEntry(this.name).catch(() => {})
        } catch {}
        cb(null)
      })()
    })
  }
}

export default OPFSSingleFileStore
