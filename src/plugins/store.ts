import { get, update } from 'idb-keyval'

import { storeKey } from './switches'

export const STORE_BYTES = 256 * 1024

const sizeOf = (record: Record<string, string>) => new TextEncoder().encode(JSON.stringify(record)).byteLength

export const storeGet = async (uri: string, key: string): Promise<string | null> => {
  if (typeof key !== 'string') throw new Error('invalid')
  return (await get<Record<string, string>>(storeKey(uri)))?.[key] ?? null
}

/** Rejects with `full` when the plugin's strings would pass {@link STORE_BYTES}, as JSON, and keeps what it had. */
export const storeSet = async (uri: string, key: string, value: string | null): Promise<void> => {
  if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) throw new Error('invalid')
  let full = false
  await update<Record<string, string>>(storeKey(uri), (stored) => {
    const { [key]: _old, ...rest } = stored ?? {}
    const next = value === null ? rest : { ...rest, [key]: value }
    full = sizeOf(next) > STORE_BYTES
    return full ? (stored ?? {}) : next
  })
  if (full) throw new Error('full')
}
