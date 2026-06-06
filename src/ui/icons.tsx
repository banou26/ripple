// Ripple — icon set + logo, ported byte-faithfully from the design prototype.

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

export const Icon = {
  Search: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  ),
  Plus: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  Stream: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <path d="M2 5c1.5-1.6 3-1.6 4.5 0S9.5 6.6 11 5s3-1.6 3 0" />
      <path d="M2 9c1.5-1.6 3-1.6 4.5 0S9.5 10.6 11 9s3-1.6 3 0" opacity=".6" />
      <path d="M2 13c1.5-1.6 3-1.6 4.5 0S9.5 14.6 11 13s3-1.6 3 0" opacity=".35" />
    </svg>
  ),
  Library: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6h11M6 2.5v11" />
    </svg>
  ),
  Settings: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3 3.4 12.6M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4" />
    </svg>
  ),
  Pause: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <rect x="4" y="3.5" width="2.5" height="9" rx="0.6" />
      <rect x="9.5" y="3.5" width="2.5" height="9" rx="0.6" />
    </svg>
  ),
  Play: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <path d="M5 3.4v9.2c0 .5.6.8 1 .5l7.2-4.6a.6.6 0 0 0 0-1L6 2.9c-.4-.3-1 0-1 .5z" />
    </svg>
  ),
  More: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <circle cx="4" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12" cy="8" r="1.2" />
    </svg>
  ),
  Close: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  ),
  ArrowDown: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </svg>
  ),
  Download: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 2v7.5M5 7l3 3 3-3" />
      <path d="M2.8 11.5v1.2c0 .4.3.8.8.8h8.8c.5 0 .8-.4.8-.8v-1.2" />
    </svg>
  ),
  Trash: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.5 8c0 .5.4.9.9.9h3.2c.5 0 .9-.4.9-.9l.5-8" />
    </svg>
  ),
  ArrowUp: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  ),
  File: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 2h6l3 3v9H3.5z" />
      <path d="M9.5 2v3h3" />
    </svg>
  ),
  Magnet: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 3v5a4.5 4.5 0 0 0 9 0V3" />
      <path d="M3.5 3h3v3.5M12.5 3h-3v3.5" />
    </svg>
  ),
  Chevron: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M5 4l4 4-4 4" />
    </svg>
  ),
  Check: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8.3l3.2 3.2L13 4.5" />
    </svg>
  ),
  Folder: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  ),
  Sun: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4 3.5 12.5M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5" />
    </svg>
  ),
  Moon: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <path d="M13.7 9.7A6 6 0 0 1 6.3 2.3a6 6 0 1 0 7.4 7.4z" />
    </svg>
  ),
  Globe: (p: IconProps) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.5" ry="6" />
      <path d="M2 8h12" />
    </svg>
  ),
}

type LogoProps = { size?: number }

// Logo: stylized concentric ripple
export const Logo = ({ size = 28 }: LogoProps) => (
  <svg viewBox="0 0 28 28" width={size} height={size} aria-label="Ripple">
    <defs>
      <radialGradient id="rip-g" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="var(--accent)" stopOpacity="1" />
        <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
      </radialGradient>
    </defs>
    <circle cx="14" cy="14" r="13" fill="none" stroke="var(--accent)" strokeWidth="1" opacity=".25" />
    <circle cx="14" cy="14" r="9" fill="none" stroke="var(--accent)" strokeWidth="1" opacity=".5" />
    <circle cx="14" cy="14" r="5" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
    <circle cx="14" cy="14" r="1.8" fill="var(--accent)" />
  </svg>
)
