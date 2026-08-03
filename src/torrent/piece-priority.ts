// libtorrent piece priorities. 0 would mean "do not download", which nothing here wants.
export const BEHIND = 1
export const NORMAL = 4
export const AHEAD = 7

// One player's stake, in piece indices: the file spans p0..p1 and the playhead sits at pAt
export type Claim = { p0: number, p1: number, pAt: number }

export const mergePriorities = (numPieces: number, claims: Claim[]): Uint8Array => {
  const out = new Uint8Array(Math.max(0, numPieces))
  out.fill(NORMAL)
  const claimed = new Uint8Array(out.length)
  for (const { p0, p1, pAt } of claims) {
    for (let p = Math.max(0, p0); p <= p1 && p < out.length; p++) {
      const want = p >= pAt ? AHEAD : BEHIND
      if (want > claimed[p]!) claimed[p] = want
    }
  }
  for (let p = 0; p < out.length; p++) if (claimed[p]) out[p] = claimed[p]!
  return out
}
