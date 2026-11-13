import type { Page } from '@playwright/test'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { Fixture } from './fixture'

/** The fixture as OPFS holds it: bytes in pieces that hash to the torrent's, and the whole file's SHA-256. */
export const readFixture = (page: Page, fixture: Fixture) => {
  const bytes = readFileSync(fixture.file)
  const hashes: string[] = []
  for (let at = 0; at < bytes.length; at += fixture.pieceLength) {
    hashes.push(createHash('sha1').update(bytes.subarray(at, at + fixture.pieceLength)).digest('hex'))
  }
  return page.evaluate(async ({ infoHash, name, pieceLength, hashes }) => {
    const root = await navigator.storage.getDirectory()
    const empty = { found: false, size: 0, matchedBytes: 0, sha256: null as string | null, layout: null as string | null }
    const dirOf = async (path: string[]) => {
      let at: FileSystemDirectoryHandle | null = root
      for (const segment of path) at = at && await at.getDirectoryHandle(segment).catch(() => null)
      return at
    }
    const find = async (at: FileSystemDirectoryHandle): Promise<FileSystemFileHandle | null> => {
      for await (const child of (at as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
        if (child.kind === 'file' && child.name === name) return child as FileSystemFileHandle
        if (child.kind === 'directory') {
          const found = await find(child as FileSystemDirectoryHandle)
          if (found) return found
        }
      }
      return null
    }
    // a kept torrent is one file under /dl/<infoHash>; a watched one is chunk files under
    // /cache/<infoHash>/<chunk size>/<file index>-<k>, chunk k holding bytes [k * size, (k + 1) * size)
    let data: Uint8Array<ArrayBuffer> | null = null
    let layout: string | null = null
    const kept = await dirOf(['dl', infoHash])
    const handle = kept && await find(kept)
    if (handle) {
      const file = await handle.getFile().catch(() => null)
      if (!file) return { ...empty, found: true, layout: 'dl, unreadable' }
      data = new Uint8Array(await file.arrayBuffer())
      layout = 'dl'
    } else {
      const cache = await dirOf(['cache', infoHash])
      if (!cache) return empty
      for await (const sizeDir of (cache as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
        if (sizeDir.kind !== 'directory' || !/^\d+$/.test(sizeDir.name)) continue
        const chunkBytes = Number(sizeDir.name)
        const parts: { k: number, bytes: Uint8Array<ArrayBuffer> }[] = []
        for await (const chunk of (sizeDir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
          const m = /^0-(\d+)$/.exec(chunk.name)
          if (chunk.kind !== 'file' || !m) continue
          const file = await (chunk as FileSystemFileHandle).getFile().catch(() => null)
          if (!file) return { ...empty, found: true, layout: 'cache, unreadable' }
          parts.push({ k: Number(m[1]), bytes: new Uint8Array(await file.arrayBuffer()) })
        }
        if (!parts.length) continue
        const length = Math.max(...parts.map((p) => p.k * chunkBytes + p.bytes.length))
        data = new Uint8Array(length)
        for (const p of parts) data.set(p.bytes, p.k * chunkBytes)
        layout = `cache, ${parts.length} chunk(s) of ${chunkBytes}`
      }
    }
    if (!data) return empty
    const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
    let matchedBytes = 0
    for (const [i, expected] of hashes.entries()) {
      const piece = data.subarray(i * pieceLength, (i + 1) * pieceLength)
      if (piece.length && hex(await crypto.subtle.digest('SHA-1', piece)) === expected) matchedBytes += piece.length
    }
    return { found: true, size: data.length, matchedBytes, sha256: hex(await crypto.subtle.digest('SHA-256', data)), layout }
  }, { infoHash: fixture.infoHash, name: fixture.name, pieceLength: fixture.pieceLength, hashes })
}
