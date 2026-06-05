// Ripple — generative cover art, sparkline chart + peer flag chip.
// Ported byte-faithfully from the design prototype.

import { nameHash } from './format'
import type { TorrentState } from './types'

type CoverProps = { name: string, size?: number, state?: TorrentState }

// Generative cover art — abstract concentric "ripple" tile per torrent.
// Hue derived from the name; deterministic.
export const Cover = ({ name, size = 40, state }: CoverProps) => {
  const h = nameHash(name)
  const hue = h % 360
  const hue2 = (hue + 40 + (h % 60)) % 360
  const variant = h % 4
  const c1 = `oklch(0.62 0.15 ${hue})`
  const c2 = `oklch(0.34 0.16 ${hue2})`
  const id = 'cv' + h
  const r = size > 80 ? 14 : size > 56 ? 10 : 8
  return (
    <div className="cover" style={{ width: size, height: size, borderRadius: r }}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1} />
            <stop offset="1" stopColor={c2} />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#${id})`} />
        {variant === 0 && (
          <g stroke="rgba(255,255,255,0.22)" fill="none" strokeWidth="1">
            <circle cx="50" cy="50" r="44" />
            <circle cx="50" cy="50" r="32" />
            <circle cx="50" cy="50" r="20" />
            <circle cx="50" cy="50" r="8" fill="rgba(255,255,255,0.4)" stroke="none" />
          </g>
        )}
        {variant === 1 && (
          <g stroke="rgba(255,255,255,0.2)" fill="none" strokeWidth="1">
            <circle cx="20" cy="80" r="60" />
            <circle cx="20" cy="80" r="44" />
            <circle cx="20" cy="80" r="28" />
            <circle cx="20" cy="80" r="14" fill="rgba(255,255,255,0.32)" stroke="none" />
          </g>
        )}
        {variant === 2 && (
          <g fill="rgba(255,255,255,0.16)">
            <path d="M0 70 Q 25 50 50 70 T 100 70 V100 H0 Z" />
            <path d="M0 80 Q 25 60 50 80 T 100 80 V100 H0 Z" fillOpacity="0.5" />
            <circle cx="78" cy="28" r="10" fill="rgba(255,255,255,0.5)" />
          </g>
        )}
        {variant === 3 && (
          <g stroke="rgba(255,255,255,0.22)" fill="none" strokeWidth="1.2" strokeLinecap="round">
            <path d="M0 60 Q 25 40 50 60 T 100 60" />
            <path d="M0 70 Q 25 50 50 70 T 100 70" />
            <path d="M0 80 Q 25 60 50 80 T 100 80" opacity="0.7" />
            <path d="M0 50 Q 25 30 50 50 T 100 50" opacity="0.6" />
          </g>
        )}
      </svg>
      {state && (
        <span className="cover-status" data-state={state}>
          <i />
        </span>
      )}
    </div>
  )
}

type SparklineProps = { down: number[], up: number[] }

export const Sparkline = ({ down, up }: SparklineProps) => {
  const w = 380, h = 76
  const max = Math.max(...down, ...up, 1)
  const toPath = (arr: number[]) => {
    const step = w / (arr.length - 1)
    return arr.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - (v / max) * h).toFixed(1)}`).join(' ')
  }
  const toArea = (arr: number[]) => `${toPath(arr)} L ${w} ${h} L 0 ${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="chart-svg">
      <defs>
        <linearGradient id="g-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".25" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="g-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--good)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--good)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={toArea(down)} fill="url(#g-down)" />
      <path d={toPath(down)} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinejoin="round" />
      <path d={toArea(up)} fill="url(#g-up)" />
      <path d={toPath(up)} fill="none" stroke="var(--good)" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

type PeerFlagProps = { code: string }

// Country flag stub — uses 2-letter code in mono inside a chip
export const PeerFlag = ({ code }: PeerFlagProps) => <span className="peer-flag">{code}</span>
