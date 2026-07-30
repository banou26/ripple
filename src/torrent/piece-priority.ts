// Turning "who is watching what" into libtorrent's per-piece priority array.
//
// The array is global to a torrent, but the players wanting it are not: one tab can watch a
// file while another watches a different file of the same torrent, and both have a claim.
// Building it for the newest viewer alone is what used to reset the other one's file back to
// normal on every seek.

// libtorrent piece priorities. 0 would mean "do not download", which nothing here wants.
export const BEHIND = 1
export const NORMAL = 4
export const AHEAD = 7

// One player's stake in a torrent, already reduced to piece indices: the file spans p0..p1
// and the playhead sits at pAt.
export type Claim = { p0: number, p1: number, pAt: number }

export const mergePriorities = (numPieces: number, claims: Claim[]): Uint8Array => {
  const out = new Uint8Array(Math.max(0, numPieces))
  // Sized to the whole torrent rather than to one file. The array used to stop at the last
  // piece of the file being prioritized, so everything past it kept whatever an earlier call
  // had left there and a file prioritized once stayed urgent for the rest of the session.
  out.fill(NORMAL)
  const claimed = new Uint8Array(out.length)
  for (const { p0, p1, pAt } of claims) {
    for (let p = Math.max(0, p0); p <= p1 && p < out.length; p++) {
      // Highest claim wins. A piece one viewer has already played is still urgent if another
      // viewer is about to reach it.
      const want = p >= pAt ? AHEAD : BEHIND
      if (want > claimed[p]!) claimed[p] = want
    }
  }
  for (let p = 0; p < out.length; p++) if (claimed[p]) out[p] = claimed[p]!
  return out
}
