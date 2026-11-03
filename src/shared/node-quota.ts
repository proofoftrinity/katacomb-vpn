// How a node holds a session to its limits, shared by main (the quota watchdog and the
// Reconnect refusal) and the Sessions card, so the two score a session the same way.
// No Electron/DOM imports. docs/invariants/session-lifecycle.md [SL-6].

/**
 * What the node took from the chain when it admitted the session, and when its clock
 * started. Every node version stores the caps at the handshake and cuts the peer there,
 * whatever the chain says later: a plan renewal grows the chain's caps for the same
 * session, and the node never sees it.
 */
export interface NodeCaps {
  /** Bytes the node allows, download and upload together; 0 = no data cap. */
  maxBytes: number
  /** Seconds the node allows; 0 = no time cap. */
  maxDurationSeconds: number
  /** When the handshake returned (ms). The node starts its clock just before it replies. */
  handshakeAtMs: number
  /** The chain's `duration` for the session at that moment. */
  durationAtHandshakeSeconds: number
}

/** The smaller of two caps where both exist; 0 means "no cap". */
const smallerCap = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : a > 0 ? a : b)

/**
 * The caps a session is held to: the chain's, or the node's from the handshake where
 * those are smaller. Smaller is the only direction that matters: the node cuts at its
 * own figure, and a chain figure that shrank (a plan's allocation spent by another
 * session) is what the chain will settle against.
 */
export function effectiveCaps(
  chain: { maxBytes: number; maxDurationSeconds: number | null },
  node: NodeCaps | undefined,
): { maxBytes: number; maxDurationSeconds: number | null } {
  if (!node) return chain
  const seconds = smallerCap(chain.maxDurationSeconds ?? 0, node.maxDurationSeconds)
  return { maxBytes: smallerCap(chain.maxBytes, node.maxBytes), maxDurationSeconds: seconds > 0 ? seconds : null }
}

/**
 * The node's reading of the session's duration at `atMs`: wall-clock from its handshake,
 * gaps between connects included. Both node types count it this way, and the chain
 * settles what the node reports ([REL-21] measured it). The node only moves its figure on
 * activity, so read it at the last sign of life for usage, and at now for what a
 * reconnect would cost.
 */
export function nodeClockSeconds(node: NodeCaps, atMs: number): number {
  return node.durationAtHandshakeSeconds + Math.max(0, atMs - node.handshakeAtMs) / 1000
}

/** When the node's clock reaches `maxDurationSeconds` (ms). */
export function paidTimeEndsAtMs(node: NodeCaps, maxDurationSeconds: number): number {
  return node.handshakeAtMs + (maxDurationSeconds - node.durationAtHandshakeSeconds) * 1000
}
