// Format + deterministic-generative helpers for the Ripple UI.

export const fmtBytes = (mb: number | null | undefined): string => {
  if (mb == null) return '-'
  if (mb >= 1024) return (mb / 1024).toFixed(mb >= 10240 ? 1 : 2) + ' GB'
  if (mb >= 1) return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB'
  return (mb * 1024).toFixed(0) + ' KB'
}

export const fmtSpeed = (kbs: number): string => {
  if (!kbs) return '-'
  if (kbs >= 1024) return (kbs / 1024).toFixed(1) + ' MB/s'
  return kbs.toFixed(0) + ' KB/s'
}

// Deterministic hash of a name → drives the per-torrent generative cover hue.
export const nameHash = (name: string): number => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Deterministic smoothed sparkline series in [~0.4, ~0.95], seeded per id.
export const genSparkline = (seed: number, len = 40): number[] => {
  let s = seed * 9301 + 49297
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    s = (s * 9301 + 49297) % 233280
    out.push(0.4 + (s / 233280) * 0.55)
  }
  for (let i = 1; i < out.length - 1; i++) out[i] = (out[i - 1]! + out[i]! + out[i + 1]!) / 3
  return out
}
