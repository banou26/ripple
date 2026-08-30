/**
 * What the origin is actually holding, when the browser's own answer is wrong.
 *
 * MEASURED, 2026-08-30, Chrome 151, on a library holding one verified 1,783,407,077 byte file whose
 * contents were read back dense at eight offsets:
 *
 *   navigator.storage.estimate()
 *     usage: 1813502
 *     usageDetails: { fileSystem: 752, indexedDB: 1809581, serviceWorkerRegistrations: 3169 }
 *
 * 752 bytes reported for 1.78 GB. That is not rounding or lag, it is off by six orders of magnitude,
 * and it is not universal: another machine reported the same torrent's usage correctly. So the number
 * cannot be trusted and cannot be discarded either.
 *
 * Two things read it and both are damaged by an under-report:
 *
 *  - the Storage readout, which simply lies.
 *  - `planEviction`, which decides there is room and never reclaims. What happens instead is that a
 *    write eventually fails with QuotaExceededError, and `opfs-storage.ts` classifies that as FATAL
 *    and stops the torrent rather than retrying. So an under-report does not merely mislead, it
 *    turns a recoverable full disk into a stopped download.
 *
 * The fix is to walk the file system and add it up, then take whichever answer is LARGER. Larger is
 * the safe direction on purpose: over-reporting makes the budget pass reclaim cache slightly early,
 * which is what cache is for, while under-reporting is the failure above.
 */

/** Never walk forever: a cycle is impossible in OPFS, but a pathological tree is not worth the tick. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 20_000

export type UsageEstimate = {
  usage?: number
  quota?: number
  /** Chrome only, and the whole reason this module can be precise rather than merely conservative. */
  usageDetails?: { fileSystem?: number }
}

/**
 * Bytes held by every file under `root`, or null when the walk could not be completed.
 *
 * A file the engine is writing through a sync access handle holds an exclusive lock, and `getFile()`
 * on it throws rather than waiting. Those are SKIPPED rather than failing the whole walk, so the
 * answer is a floor: it can be short by the files currently open, never long. That is the same
 * direction as everything else here, and it beats the alternative of returning nothing at all
 * exactly while a download is running.
 */
export const measureOpfsBytes = async (root: FileSystemDirectoryHandle): Promise<number | null> => {
  let total = 0
  let seen = 0
  const walk = async (dir: FileSystemDirectoryHandle, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    for await (const handle of (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
      if (++seen > MAX_ENTRIES) return
      if (handle.kind === 'directory') {
        await walk(handle as FileSystemDirectoryHandle, depth + 1)
      } else {
        // locked by a live sync access handle, or removed between listing and reading: both are
        // ordinary, and both mean this file cannot be counted rather than that the walk failed
        const size = await (handle as FileSystemFileHandle).getFile().then((f) => f.size, () => 0)
        total += size
      }
    }
  }
  try {
    await walk(root, 0)
    return total
  } catch {
    // the whole file system was unreachable, which is a different thing from a file being busy
    return null
  }
}

/**
 * The origin's usage, reconciling the browser's answer with the measured one.
 *
 * Pure, so the arithmetic can be tested without a file system. `null` means neither source knows,
 * which callers already treat as "not a full origin" rather than as zero.
 *
 * Where `usageDetails` is available the correction is surgical: the file system component is the
 * broken one, so it is replaced with the measurement and the components Chrome reports correctly
 * (IndexedDB, service worker registrations) are kept. Without it, the best available answer is
 * whichever of the two is larger.
 */
export const correctedUsage = (estimate: UsageEstimate, opfsBytes: number | null): number | null => {
  const reported = estimate.usage
  if (opfsBytes === null || opfsBytes < 0) return reported ?? null
  if (reported === undefined) return opfsBytes

  const fileSystem = estimate.usageDetails?.fileSystem
  if (typeof fileSystem === 'number') {
    // everything the browser counted that is NOT the file system, which it counts correctly
    const other = Math.max(0, reported - fileSystem)
    return Math.max(reported, opfsBytes + other)
  }
  return Math.max(reported, opfsBytes)
}

/** True when the browser's own figure is so far below the measured one that it cannot be believed. */
export const isUsageUnderReported = (estimate: UsageEstimate, opfsBytes: number | null): boolean =>
  opfsBytes !== null && opfsBytes > 0 && (estimate.usage ?? 0) < opfsBytes / 2
