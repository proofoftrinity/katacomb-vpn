import type { ReactNode } from 'react'
import { countryCode } from '../utils/country-codes'
import InfoTip from './InfoTip'
import { CheckIcon, CloseIcon, GlobeIcon, LaptopIcon } from './Icons'

/**
 * Where a connection is in its life. `step` indexes the build frames for the number
 * of hops: for a chain, the five markers main sends (ChainReviewModal's
 * MARKER_SEQUENCE) then 5 for the bring-up; for a single hop, `singleHopStep()`.
 * A failure is only ever drawn at the bring-up, when everything before it is paid.
 */
export type RouteStage =
  | { kind: 'review' }
  | { kind: 'building'; step: number }
  | { kind: 'active' }
  | { kind: 'failed' }

/** What the strip needs of a hop. A SentNode fits; the Sessions tab has no city. */
export interface RouteHop {
  country: string
  city?: string
  moniker?: string
  /** Shown instead of the place, for a node not chosen yet ("Best node"). */
  name?: string
}

type NodeState = 'plan' | 'waiting' | 'busy' | 'done' | 'ok' | 'failed'
type LinkState = 'plan' | 'dim' | 'flow' | 'lit' | 'ok' | 'failed'

// Spelled out in full rather than built as `route-disc-${state}`: Tailwind keeps a
// component class only if it finds the literal name in the source, and a template
// string hides it, so the state would silently lose its style in a production build.
const DISC: Record<NodeState, string> = {
  plan: 'route-disc',
  waiting: 'route-disc route-disc-waiting',
  busy: 'route-disc route-disc-busy',
  done: 'route-disc route-disc-done',
  ok: 'route-disc route-disc-ok',
  failed: 'route-disc route-disc-failed',
}
const LINK: Record<LinkState, string> = {
  plan: 'route-link',
  dim: 'route-link route-link-dim',
  flow: 'route-link route-link-flow',
  lit: 'route-link route-link-lit',
  ok: 'route-link route-link-ok',
  failed: 'route-link route-link-failed',
}

interface Frame {
  you: NodeState
  hops: NodeState[]
  net: NodeState
  /** One more than there are hops: You→first, between hops, last→Internet. */
  links: LinkState[]
  /** Under each hop: what it sees, or where it has got to. */
  notes: string[]
}

/**
 * What each hop sees. One node sees BOTH ends, which is the whole case for a chain,
 * so the single-hop strip says it in the same place the chain says what it splits.
 */
const SEES: Record<1 | 2, string[]> = {
  1: ['sees your IP and the sites'],
  2: ['sees your IP', 'sees the sites'],
}

/**
 * The build frames. Each hop only ever moves forward. Buying is a transaction to the
 * chain, not to a node, so no link lights for it; a handshake is the first thing that
 * crosses into a node. A chain's entry is bought and handshaked before the exit is
 * touched, because the exit is reached THROUGH it.
 */
const BUILD: Record<1 | 2, Frame[]> = {
  1: [
    { you: 'done', hops: ['busy'], net: 'waiting', links: ['dim', 'dim'], notes: ['preparing'] },
    { you: 'done', hops: ['busy'], net: 'waiting', links: ['dim', 'dim'], notes: ['buying'] },
    { you: 'done', hops: ['busy'], net: 'waiting', links: ['flow', 'dim'], notes: ['handshake'] },
    { you: 'done', hops: ['done'], net: 'busy', links: ['lit', 'flow'], notes: ['done'] },
  ],
  2: [
    { you: 'done', hops: ['busy', 'waiting'], net: 'waiting', links: ['dim', 'dim', 'dim'], notes: ['buying', 'waiting'] },
    { you: 'done', hops: ['busy', 'waiting'], net: 'waiting', links: ['flow', 'dim', 'dim'], notes: ['handshake', 'waiting'] },
    { you: 'done', hops: ['done', 'busy'], net: 'waiting', links: ['lit', 'flow', 'dim'], notes: ['done', 'routing'] },
    { you: 'done', hops: ['done', 'busy'], net: 'waiting', links: ['lit', 'lit', 'dim'], notes: ['done', 'buying'] },
    { you: 'done', hops: ['done', 'busy'], net: 'waiting', links: ['lit', 'lit', 'dim'], notes: ['done', 'handshake'] },
    { you: 'done', hops: ['done', 'done'], net: 'busy', links: ['lit', 'lit', 'flow'], notes: ['done', 'done'] },
  ],
}

/**
 * A single-hop progress marker as a build step. Main's node purchase sends 1/5..5/5;
 * a plan's smart connect sends `plan:*` markers around them. Several map to one step
 * because the strip only shows what the user can see happen: preparing, buying,
 * handshaking, the tunnel. Unknown or absent markers are the start.
 */
export function singleHopStep(marker: string | null): number {
  switch (marker) {
    case '2/5': case '3/5': case 'plan:buy': case 'plan:session': return 1
    case '4/5': case 'plan:handshake': return 2
    case '5/5': return 3
    default: return 0
  }
}

function frameFor(stage: RouteStage, count: 1 | 2): Frame {
  const nodes = (s: NodeState): NodeState[] => Array(count).fill(s)
  if (stage.kind === 'review') {
    return { you: 'plan', hops: nodes('plan'), net: 'plan', links: Array(count + 1).fill('plan'), notes: SEES[count] }
  }
  if (stage.kind === 'active') {
    return { you: 'ok', hops: nodes('ok'), net: 'ok', links: Array(count + 1).fill('ok'), notes: SEES[count] }
  }
  const frames = BUILD[count]
  if (stage.kind === 'building') return frames[Math.min(Math.max(stage.step, 0), frames.length - 1)]
  // Failed at the bring-up: whatever was in flight there is what broke.
  const last = frames[frames.length - 1]
  return {
    you: last.you,
    hops: last.hops.map((s) => (s === 'busy' ? 'failed' : s)),
    net: last.net === 'busy' ? 'failed' : last.net,
    links: last.links.map((s) => (s === 'flow' ? 'failed' : s)),
    notes: SEES[count],
  }
}

/**
 * A connection as one picture: your device → the hop(s) → the internet, with what
 * each hop sees under it. The connect windows show it through the whole purchase,
 * lighting each node and link as main reports progress, so the user watches one route
 * come up instead of reading a new screen at every step. `compact` is the one-line
 * version a Sessions card heads itself with. `info` puts a "?" in the corner.
 *
 * No WebGL and no JS animation: the motion is two CSS classes in global.css, which
 * cost nothing at rest and stop under reduced motion.
 */
export default function RouteStrip({ hops, stage, compact = false, info }: {
  hops: RouteHop[]
  stage: RouteStage
  compact?: boolean
  info?: { label: string; text: ReactNode }
}) {
  const count: 1 | 2 = hops.length >= 2 ? 2 : 1
  const shown = hops.slice(0, count)
  const f = frameFor(stage, count)
  const where = (h: RouteHop) => h.name || h.city || h.country || 'Unknown'
  const label = `Route: your device, then ${shown.map(where).join(', then ')}, then the internet.`

  if (compact) {
    return (
      <span role="img" aria-label={label} className="flex items-center gap-1.5 min-w-0 text-xs">
        <LaptopIcon className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
        {shown.map((h, i) => (
          <span key={i} className="contents">
            <span className={`${LINK[f.links[i]]} w-4 shrink-0`} />
            <Flag country={h.country} size={14} />
            <span className="text-text-primary truncate">{where(h)}</span>
          </span>
        ))}
        <span className={`${LINK[f.links[count]]} w-4 shrink-0`} />
        <GlobeIcon className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
      </span>
    )
  }

  const last = shown[count - 1]
  return (
    <div
      role="img"
      aria-label={label}
      // Literal class strings per hop count, for the same Tailwind reason as DISC.
      className={`relative grid items-start px-2.5 pt-4 pb-3.5 bg-bg-primary border border-border rounded-md ${
        count === 2
          ? 'grid-cols-[auto_minmax(16px,1fr)_auto_minmax(16px,1.5fr)_auto_minmax(16px,1fr)_auto]'
          : 'grid-cols-[auto_minmax(16px,1fr)_auto_minmax(16px,1fr)_auto]'
      }`}
    >
      <Stop state={f.you} name="You" sub="your device">
        <LaptopIcon className="w-5 h-5" />
      </Stop>
      {shown.map((h, i) => (
        <span key={i} className="contents">
          <Line state={f.links[i]} label={i === 1 ? 'exit set up through the entry' : undefined} />
          <Stop state={f.hops[i]} hop name={where(h)} sub={h.moniker} note={f.notes[i]}>
            <Flag country={h.country} size={30} />
          </Stop>
        </span>
      ))}
      <Line state={f.links[count]} />
      <Stop state={f.net} name="Internet" sub={`sites see ${last.country || 'the node'}`}>
        <GlobeIcon className="w-5 h-5" />
      </Stop>
      {info && (
        <span className="absolute top-2 right-2">
          <InfoTip label={info.label}>{info.text}</InfoTip>
        </span>
      )}
    </div>
  )
}

function Stop({ state, hop = false, name, sub, note, children }: {
  state: NodeState
  /** Only the hops get a done/failed badge; You and Internet are just the ends. */
  hop?: boolean
  name: string
  sub?: string
  note?: string
  children: ReactNode
}) {
  return (
    <div className="w-[96px] flex flex-col items-center text-center min-w-0">
      <div className={`${DISC[state]} w-10 h-10 mb-1.5`}>
        {children}
        {hop && (state === 'done' || state === 'ok') && (
          <span className={`absolute -right-1.5 -bottom-1.5 w-[17px] h-[17px] rounded-full grid place-items-center border-2 border-bg-primary text-text-on-accent ${
            state === 'ok' ? 'bg-success' : 'bg-accent'
          }`}>
            <CheckIcon className="w-2.5 h-2.5" />
          </span>
        )}
        {state === 'failed' && (
          <span className="absolute -right-1.5 -bottom-1.5 w-[17px] h-[17px] rounded-full grid place-items-center border-2 border-bg-primary bg-danger text-text-on-accent">
            <CloseIcon className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
      <span className="text-xs font-semibold text-text-primary max-w-full truncate">{name}</span>
      {sub && <span className="text-[11px] text-text-tertiary max-w-full truncate">{sub}</span>}
      {note && (
        <span className={`text-[11px] mt-0.5 leading-tight ${
          state === 'busy' ? 'text-accent' : state === 'ok' ? 'text-success' : 'text-text-secondary'
        }`}>
          {note}
        </span>
      )}
    </div>
  )
}

function Line({ state, label }: { state: LinkState; label?: string }) {
  return (
    // 19px puts the 2px line through the middle of the 40px discs either side.
    <div className={`${LINK[state]} mt-[19px]`}>
      {label && (
        <span className="absolute top-2.5 inset-x-0.5 text-center text-[10.5px] leading-snug text-text-tertiary">
          {label}
        </span>
      )}
      {state === 'failed' && (
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full grid place-items-center bg-bg-primary border border-danger text-danger">
          <CloseIcon className="w-3 h-3" />
        </span>
      )}
    </div>
  )
}

/** A round flag (flag-icons' square variant), the initials without one, "?" without a country. */
function Flag({ country, size }: { country: string; size: number }) {
  const code = countryCode(country)
  if (!code) {
    return <span className="text-[10px] font-semibold text-text-secondary">{country.slice(0, 2).toUpperCase() || '?'}</span>
  }
  return (
    <span
      className={`fi fis fi-${code} rounded-full shrink-0`}
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
      title={country}
    />
  )
}
