/**
 * An origin private file system in memory, with the two OPFS rules a chunked storage depends on:
 * one sync access handle per file at a time, and no `removeEntry` while one is open (both measured
 * on Firefox 157 and Chromium 149, 2026-10-19: `NoModificationAllowedError`).
 */

type Node = MemoryDir | MemoryFile

export type MemoryFile = {
  kind: 'file'
  name: string
  bytes: Uint8Array
  open: boolean
  getFile: () => Promise<{ size: number }>
  createSyncAccessHandle: () => Promise<MemoryHandle>
}

export type MemoryHandle = {
  read: (buffer: Uint8Array, options?: { at?: number }) => number
  write: (buffer: Uint8Array, options?: { at?: number }) => number
  getSize: () => number
  truncate: (size: number) => void
  flush: () => void
  close: () => void
}

export type MemoryDir = {
  kind: 'directory'
  name: string
  children: Map<string, Node>
  values: () => AsyncIterable<Node>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<MemoryDir>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<MemoryFile>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
}

const domError = (name: string, message: string) => Object.assign(new Error(message), { name })

/** `room.bytes` is what a write may still add to the origin; a write past it lands short, as on Firefox. */
export const memoryFile = (name: string, bytes = new Uint8Array(0), room = { bytes: Infinity }): MemoryFile => {
  const file: MemoryFile = {
    kind: 'file',
    name,
    bytes,
    open: false,
    getFile: async () => {
      if (file.open) throw domError('NoModificationAllowedError', `${name} is locked`)
      return { size: file.bytes.length }
    },
    createSyncAccessHandle: async () => {
      if (file.open) throw domError('NoModificationAllowedError', `${name} is locked`)
      file.open = true
      let closed = false
      const live = () => { if (closed) throw domError('InvalidStateError', `${name} is closed`) }
      return {
        read: (buffer, options) => {
          live()
          const at = options?.at ?? 0
          const part = file.bytes.subarray(at, at + buffer.length)
          buffer.set(part)
          return part.length
        },
        write: (buffer, options) => {
          live()
          const at = options?.at ?? 0
          const grows = Math.max(0, at + buffer.length - file.bytes.length)
          const fits = grows <= room.bytes ? buffer.length : Math.max(0, buffer.length - (grows - room.bytes))
          if (!fits) return 0
          const end = at + fits
          if (end > file.bytes.length) {
            const next = new Uint8Array(end)
            next.set(file.bytes)
            room.bytes -= end - file.bytes.length
            file.bytes = next
          }
          file.bytes.set(buffer.subarray(0, fits), at)
          return fits
        },
        getSize: () => { live(); return file.bytes.length },
        truncate: (size) => { live(); file.bytes = file.bytes.slice(0, size) },
        flush: () => { live() },
        close: () => { if (!closed) { closed = true; file.open = false } },
      }
    },
  }
  return file
}

export const memoryDir = (name: string, children: Node[] = [], room = { bytes: Infinity }): MemoryDir => {
  const map = new Map<string, Node>(children.map((child) => [child.name, child]))
  return {
    kind: 'directory',
    name,
    children: map,
    values: () => ({ async *[Symbol.asyncIterator] () { for (const child of [...map.values()]) yield child } }),
    getDirectoryHandle: async (child, options) => {
      const found = map.get(child)
      if (found?.kind === 'directory') return found
      if (found || !options?.create) throw domError('NotFoundError', `no directory ${child}`)
      const made = memoryDir(child, [], room)
      map.set(child, made)
      return made
    },
    getFileHandle: async (child, options) => {
      const found = map.get(child)
      if (found?.kind === 'file') return found
      if (found || !options?.create) throw domError('NotFoundError', `no file ${child}`)
      const made = memoryFile(child, new Uint8Array(0), room)
      map.set(child, made)
      return made
    },
    removeEntry: async (child, options) => {
      // a real delete settles later than the call, which is the window a write can race into
      await new Promise((resolve) => setTimeout(resolve, 0))
      const found = map.get(child)
      if (!found) throw domError('NotFoundError', `no entry ${child}`)
      const locked = (node: Node): boolean => node.kind === 'file' ? node.open : [...node.children.values()].some(locked)
      if (locked(found)) throw domError('NoModificationAllowedError', `${child} is locked`)
      if (found.kind === 'directory' && found.children.size && !options?.recursive) throw domError('InvalidModificationError', `${child} is not empty`)
      map.delete(child)
    },
  }
}

/** Make `root` the origin's file system for whatever runs next. */
export const installOpfs = (root: MemoryDir) => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { storage: { getDirectory: async () => root } },
  })
}
