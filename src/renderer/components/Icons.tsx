// The renderer's icon set: hand-drawn 16x16 strokes, one function per glyph, in the
// same idiom the older inline SVGs use (IpDisplay). They exist
// because Unicode glyphs are not portable across the app's targets: the obvious
// "duplicate" glyph (U+29C9) is absent from DejaVu Sans, so it rendered as a box on a
// minimal Debian install. An SVG path looks the same everywhere. Ship only icons with
// a caller; a dead export drifts and gets imported by mistake.

import type { ReactNode } from 'react'

interface IconProps {
  className?: string
}

function Svg({ className = 'w-4 h-4', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  )
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 2v4.5H6" />
      <path d="M3.5 10.5a5.5 5.5 0 1 0 .6-6.6L1.5 6.5" />
    </Svg>
  )
}

export function StarIcon({ filled = false, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path
        d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  )
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </Svg>
  )
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </Svg>
  )
}

export function ActivityIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8h3l2-5 3 10 2-5h3" />
    </Svg>
  )
}

export function PowerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 1.8v6" />
      <path d="M4.7 4.2a4.5 4.5 0 1 0 6.6 0" />
    </Svg>
  )
}

export function HeartIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 13.6S2 9.9 2 5.9a3 3 0 0 1 6-1.2 3 3 0 0 1 6 1.2c0 4-6 7.7-6 7.7z" />
    </Svg>
  )
}

export function HomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 7.5L8 2.5l5.5 5v6H10v-4H6v4H2.5z" />
    </Svg>
  )
}

export function ShieldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 3.2L8 1.8l5 1.4v4.3c0 3.3-2.2 5.6-5 6.7-2.8-1.1-5-3.4-5-6.7z" />
      <path d="M6 8l1.5 1.5L10.5 6.5" />
    </Svg>
  )
}

export function KeyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="8" r="2.8" />
      <path d="M7.8 8H14M11.5 8v2.5M13.5 8v1.8" />
    </Svg>
  )
}

export function LayersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5l6 3-6 3-6-3z" />
      <path d="M2 9l6 3 6-3" />
    </Svg>
  )
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function ChevronIcon({ direction, ...p }: IconProps & { direction: 'up' | 'down' }) {
  return (
    <Svg {...p}>
      <path d={direction === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
    </Svg>
  )
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.6v2.8" />
      <circle cx="8" cy="11.4" r="0.55" fill="currentColor" />
    </Svg>
  )
}

export function LaptopIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3.5" width="10" height="7" rx="1" />
      <path d="M1.5 13h13" />
    </Svg>
  )
}

export function GlobeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2.1 2 9.9 0 12M8 2c-2 2.1-2 9.9 0 12" />
    </Svg>
  )
}

export function SparkleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7.5 1.5l1.3 3.7 3.7 1.3-3.7 1.3-1.3 3.7-1.3-3.7L2.5 6.5l3.7-1.3z" />
      <path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </Svg>
  )
}

export function SwapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" />
    </Svg>
  )
}

export function ArrowRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  )
}

export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  )
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
      <path d="M9 4l3 3" />
    </Svg>
  )
}

export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  )
}

export function ChartIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" />
    </Svg>
  )
}
