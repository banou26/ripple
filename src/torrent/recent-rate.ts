type Sample = {
  at: number
  totalDone: number
}

export type RecentRateTracker = {
  sample: (handle: number, totalDone: number, at: number) => number | null
  reset: (handle: number) => void
  retain: (handles: Set<number>) => void
}

export const createRecentRateTracker = (
  windowMs = 2_000,
  minIntervalMs = 1_000,
): RecentRateTracker => {
  const samples = new Map<number, Sample[]>()

  return {
    sample: (handle, totalDone, at) => {
      const history = samples.get(handle)
      const last = history?.at(-1)
      if (!history || !last || totalDone < last.totalDone || at <= last.at || at - last.at > windowMs) {
        samples.set(handle, [{ at, totalDone }])
        return null
      }

      history.push({ at, totalDone })
      const cutoff = at - windowMs
      while (history.length > 2 && history[1]!.at <= cutoff) history.shift()

      const first = history[0]!
      const elapsedMs = at - first.at
      if (elapsedMs < minIntervalMs) return null
      return Math.max(0, totalDone - first.totalDone) * 1_000 / elapsedMs
    },
    reset: (handle) => samples.delete(handle),
    retain: (handles) => {
      for (const handle of samples.keys()) if (!handles.has(handle)) samples.delete(handle)
    },
  }
}
