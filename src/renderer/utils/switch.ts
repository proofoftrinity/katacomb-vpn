import type { ConnectionStatus } from '../types'

/**
 * Starting a connection while one is live ([RN-10], docs/renderer.md). Being connected
 * is the normal state of a VPN app, so a connect window never refuses for it: it says
 * what a switch does and offers it. main still refuses a purchase while connected
 * ([REL-3]); a switch leaves the live connection first, then buys.
 */

/** The live connection a switch leaves, captured when Pay is pressed. */
export interface PreviousConnection {
  /** The session to go back to. For a chain it is the entry, and reconnecting it rebuilds both hops. */
  sessionId: string | null
  /** How the windows name it: the node, or the chain's two ends. */
  label: string
  chain: boolean
  /** Local proxy mode: routing was never changed, so leaving it opens no gap for other apps. */
  proxyMode: boolean
}

/** What a window is about to connect to: a node, a plan subscription, or a chain's two ends. */
export type SwitchTarget =
  | { node: string }
  | { subscriptionId: string }
  | { entry: string; exit: string }

export function isLive(status: ConnectionStatus): boolean {
  return status.state === 'connected' || status.state === 'reconnecting'
}

/**
 * 'same' when the target is what the live connection already runs through, so the
 * window says so instead of selling it again; 'switch' for anything else while
 * connected. A single hop is never the same as a chain, even through the chain's entry:
 * moving from the chain to that node alone is a real switch.
 */
export function connectionRelation(status: ConnectionStatus, target: SwitchTarget): 'idle' | 'same' | 'switch' {
  if (!isLive(status)) return 'idle'
  const exit = status.chainExit
  if ('entry' in target) {
    return exit !== undefined && status.nodeAddress === target.entry && exit.address === target.exit ? 'same' : 'switch'
  }
  if (exit !== undefined) return 'switch'
  if ('node' in target) return status.nodeAddress === target.node ? 'same' : 'switch'
  return status.subscriptionId != null && status.subscriptionId === target.subscriptionId ? 'same' : 'switch'
}

/** The live connection, as a switch names it and as "go back" reconnects it. null when idle. */
export function previousConnection(status: ConnectionStatus): PreviousConnection | null {
  if (!isLive(status)) return null
  const exit = status.chainExit
  const entryName = status.nodeMoniker || status.nodeCountry || ''
  return {
    sessionId: status.sessionId ?? null,
    label: exit !== undefined
      ? `your chain (${entryName || 'entry'} → ${exit.moniker || exit.country || 'exit'})`
      : entryName || 'your current node',
    chain: exit !== undefined,
    proxyMode: status.proxyMode === true,
  }
}

/**
 * Leave the live connection (when there is one), then buy. The purchase never starts
 * if the leave failed: the user is still connected and main would refuse it anyway.
 * `onLeft` fires once the old tunnel is down, which is when going back to it becomes
 * something to offer.
 */
export async function switchThenBuy<T>(steps: {
  leave: (() => Promise<void>) | null
  onLeft?: () => void
  purchase: () => Promise<T>
}): Promise<T> {
  if (steps.leave) {
    await steps.leave()
    steps.onLeft?.()
  }
  return steps.purchase()
}

/**
 * The switch row's words: what the gap costs and what happens to the session left
 * behind. Unused, a session is closed by the chain on its own [SL-1, SL-3]; nothing is
 * promised about when, since that depends on the node's last usage report.
 */
export function switchFacts(prev: PreviousConnection, killSwitch: boolean): { text: string; lines: string[]; tip: string } {
  const gap = prev.proxyMode
    ? 'The local proxy stops first. Apps pointed at it have no connection until this one is up.'
    : `Your connection drops first. Until this one is up, apps reach the internet directly${
      killSwitch ? ', and the kill switch is off' : ''}.`
  const session = prev.chain
    ? 'Both sessions of your chain stay open: go back to it from Sessions, or end it there. Left unused, the blockchain closes them by itself.'
    : `${prev.sessionId ? `Session #${prev.sessionId}` : 'Its session'} stays open: go back to it from Sessions, or end it there. Left unused, the blockchain closes it by itself.`
  return {
    text: `Switches from ${prev.label}`,
    lines: [gap, session],
    tip: prev.proxyMode
      ? 'One connection runs at a time, so the current one stops before the new one is bought.'
      : 'One connection runs at a time, and the blockchain cannot be reached through the tunnel, so the current connection has to go before the new one can be bought.',
  }
}

/** The footer's line while a switch is what Pay will do. */
export function switchFooterText(prev: PreviousConnection): string {
  return `Disconnects from ${prev.label} first. ${prev.chain ? 'Its sessions stay' : 'Its session stays'} open.`
}
