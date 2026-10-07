import type { SessionInfo } from '../types'

// What a Sessions-tab card shows and offers, as pure decisions so they can be held to
// their rules (docs/renderer.md [RN-2], docs/invariants/reliability.md [REL-24],
// docs/multihop.md [MH-10]). ActiveSessions renders them.

/** What a session's gauges show: on-chain baseline plus this tunnel's live meter. */
export interface SessionUsage {
  downloadBytes: number
  uploadBytes: number
  seconds: number
}

/** The live tunnel's meter, when this session is the one carrying it. */
export interface LiveMeter {
  rxBytes: number
  txBytes: number
  /** When this tunnel came up (ms), or null before the status poll reports it. */
  connectedAt: number | null
}

export function usagePercent(downloaded: string, max: string): number {
  const d = parseInt(downloaded, 10)
  const m = parseInt(max, 10)
  if (isNaN(d) || isNaN(m) || m === 0) return 0
  return Math.min(100, (d / m) * 100)
}

export function timePercent(elapsedSeconds: number, maxSeconds: number | null): number {
  if (!maxSeconds || maxSeconds <= 0 || elapsedSeconds <= 0) return 0
  return Math.min(100, (elapsedSeconds / maxSeconds) * 100)
}

/**
 * One reading of a row: what the chain has already metered, plus what THIS tunnel has
 * done since it came up when the row carries it. Time is measured like bytes, NOT as
 * wall-clock since startAt: the chain meters duration from the node's proofs, so a
 * session bought and never connected accrues nothing (#53647217 sat 53 minutes at
 * duration 0 while the card read an entire paid hour spent).
 */
export function usageReading(
  session: Pick<SessionInfo, 'downloadBytes' | 'uploadBytes' | 'durationSeconds'>,
  live: LiveMeter | null,
  nowMs: number,
): SessionUsage {
  return {
    downloadBytes: (parseInt(session.downloadBytes || '0', 10) || 0) + (live ? live.rxBytes : 0),
    uploadBytes: (parseInt(session.uploadBytes || '0', 10) || 0) + (live ? live.txBytes : 0),
    seconds: (session.durationSeconds ?? 0) +
      (live && live.connectedAt ? Math.max(0, (nowMs - live.connectedAt) / 1000) : 0),
  }
}

/**
 * A reading floored at the highest already shown. Usage only ever increases on chain,
 * so this states no more than the truth; it closes the gap where the live half has
 * vanished (tunnel down) but the row carrying main's remembered figure has not landed
 * yet, which made the time gauge drop from 8m to 3m and jump back.
 */
export function flooredUsage(reading: SessionUsage, floor: SessionUsage | undefined): SessionUsage {
  if (!floor) return reading
  return {
    downloadBytes: Math.max(reading.downloadBytes, floor.downloadBytes),
    uploadBytes: Math.max(reading.uploadBytes, floor.uploadBytes),
    seconds: Math.max(reading.seconds, floor.seconds),
  }
}

/** A chain's card is scored off whichever hop is further along: it ends when EITHER runs out. */
export function chainUsage(entry: SessionUsage, exit: SessionUsage | null): SessionUsage {
  return exit ? flooredUsage(entry, exit) : entry
}

type Hop = Pick<SessionInfo, 'status' | 'chainPeerSessionId' | 'chainPeerEndedByUser'>

/**
 * What a card is.
 *   open:   every hop active.
 *   broken: a chain that has lost a hop while another is still open, including a lone
 *           hop whose partner has already left the list. It carries no traffic, but the
 *           open hop still holds a deposit and can be ended.
 *   ending: the same shape, but the user ended the other hop (End is two txs).
 *   ended:  no hop active; nothing to do but wait for it to settle.
 */
export function cardState(entry: Hop, exit: Hop | null): 'open' | 'broken' | 'ending' | 'ended' {
  const hops = exit ? [entry, exit] : [entry]
  const open = hops.filter((h) => h.status === 'active')
  if (open.length === 0) return 'ended'
  if (open.length < hops.length || (!exit && entry.chainPeerSessionId)) {
    return open[0].chainPeerEndedByUser ? 'ending' : 'broken'
  }
  return 'open'
}

/**
 * The session has used everything it was paid for. 'active' does not mean usable: the
 * chain meters past the cap and leaves the row active (#53647217: 5673 s of a paid
 * 3600 s, status 1), so Connect must gate on this; End stays offered.
 */
export function quotaUsedUp(session: Pick<SessionInfo, 'maxBytes' | 'maxDurationSeconds'>, usage: SessionUsage): boolean {
  const maxBytes = parseInt(session.maxBytes, 10)
  const hasByteCap = !isNaN(maxBytes) && maxBytes > 0
  const hasTimeCap = session.maxDurationSeconds !== null && session.maxDurationSeconds > 0
  const dataPct = usagePercent(String(Math.round(usage.downloadBytes)), session.maxBytes)
  const timePct = timePercent(usage.seconds, session.maxDurationSeconds)
  return (hasTimeCap && timePct >= 100) || (hasByteCap && dataPct >= 100)
}
