import { sha256 } from './merkle'

/**
 * The bytes the reference torrents describe, regenerated rather than shipped.
 *
 * A sha256 chain from each file's own seed, matching the generator that built the fixtures. Shipping
 * the content would make `reference-torrents.ts` megabytes instead of kilobytes; regenerating it
 * costs milliseconds and keeps the rule in one readable place.
 *
 * INCOMPRESSIBLE on purpose. Content that repeated would let two different padding rules agree by
 * accident, which is exactly what the reference vectors exist to rule out.
 */
export const referenceBytes = async (seed: string, size: number): Promise<Uint8Array> => {
  const out = new Uint8Array(size)
  let hash = await sha256(new TextEncoder().encode(seed))
  for (let at = 0; at < size; at += 32) {
    hash = await sha256(hash)
    out.set(hash.subarray(0, Math.min(32, size - at)), at)
  }
  return out
}
