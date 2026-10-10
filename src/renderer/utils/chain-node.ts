import type { ChainEligibility, SentNode } from '../types'
// Type only: the native test runner cannot resolve an extensionless import of a
// sibling module, so the pair rule itself is passed in by the caller.
import type { PairConflict } from './chain-diversity'

/**
 * The rules that decide which nodes a two-hop chain may be built from, kept apart
 * from the page that renders them so the one that costs money is a test rather than
 * a comment.
 */

export type ChainRole = 'entry' | 'exit'
export type BillingType = 'gigabytes' | 'hours'

/**
 * Only v2ray/xray can be chained at all: the exit is dialled through the entry with
 * `proxySettings.tag`, a v2ray-core feature no other protocol in this client has an
 * equivalent for.
 */
const CHAINABLE_TYPES = [2, 4]

/** The protocol and health half of the rule, before the version is considered. */
function couldCarryChain(node: SentNode): boolean {
  return CHAINABLE_TYPES.includes(node.type) && node.isActive && node.isHealthy
}

/**
 * Whether the Multi-hop tab lists this node: a v2ray/xray node, active and healthy,
 * new enough to be checked before paying (`isCheckable`). The tab's filter bar counts
 * exactly these, so its total is the number of nodes a chain could be built from.
 */
export function isChainable(node: SentNode): boolean {
  return couldCarryChain(node) && isCheckable(node)
}

/**
 * A node `isChainable` leaves out ONLY for its version. The tab uses it to explain a
 * search that finds nothing because the node the user typed is one of these.
 */
export function isTooOldToChain(node: SentNode): boolean {
  return couldCarryChain(node) && !isCheckable(node)
}

/**
 * Only v9.0.0 nodes publish the inbound listing the chain checks read, so anything
 * older cannot be graded before paying. 485 of the 487 measured report no TLS at all,
 * so picking one is a near-certain double refund rather than a gamble worth offering.
 *
 * They used to stay LISTED, greyed out, so the table explained itself instead of
 * silently hiding what was then most of the network. Since 2026-10-05 they are not
 * listed (`isChainable`): by then they were 234 of 868 (27%), none ever pickable, and
 * they sorted in among the usable rows. A search that matches only these says so.
 */
export function majorVersion(node: SentNode): number {
  return parseInt((node.version || '').split('.')[0], 10) || 0
}

/** Whether this node can be graded at all, i.e. whether probing it can tell us anything. */
export function isCheckable(node: SentNode): boolean {
  return majorVersion(node) >= 9
}

export function udvpnPrice(node: SentNode, type: BillingType): number | null {
  const prices = type === 'gigabytes' ? node.gigabytePrices : node.hourlyPrices
  const p = prices?.find((x) => x.denom === 'udvpn')
  if (!p) return null
  const value = parseInt(p.value, 10)
  return Number.isFinite(value) ? value : null
}

export interface ChainRowState {
  /**
   * Whether this row may be picked for `role`. True ONLY on positive evidence: a
   * node that has not answered the check yet, one that could not be reached, and one
   * too old to publish anything to check are all false. Under the chain's TLS rule an
   * unverifiable node is not a maybe, it is a near-certain refund, and leaving those
   * clickable cost a real pair of sessions whose refund then failed.
   */
  selectable: boolean
  /** The short text in the eligibility column. */
  badge: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
  /** The full explanation, for the row's `title`. */
  title: string
}

/**
 * `conflict` is `pairConflict(node, otherHop)` when the other hop is already picked,
 * else null. It is checked first: unlike a grade it is known at once and never
 * changes, so it is the more useful thing to say about the row.
 */
export function chainRowState(
  node: SentNode,
  grade: ChainEligibility | undefined,
  role: ChainRole,
  conflict: PairConflict | null,
): ChainRowState {
  if (conflict !== null) {
    return {
      selectable: false,
      badge: conflict.badge,
      tone: 'danger',
      title: `${conflict.title} A chain needs its two hops in different countries and on different networks.`,
    }
  }

  if (!isCheckable(node)) {
    // Never probed, so say what is actually known: its version. "unknown" made a
    // knowable fact look like a failure.
    return {
      selectable: false,
      badge: `v${node.version || '8.x'}`,
      tone: 'muted',
      title: `This node runs ${node.version || 'a pre-9.0.0 version'}, which does not publish its inbound list, so it cannot be checked before you pay. Almost none of them offer TLS, so this will very likely be refused at the handshake and refunded.`,
    }
  }

  if (grade === undefined) {
    return {
      selectable: false,
      badge: 'checking…',
      tone: 'muted',
      title: 'Asking this node which inbounds it serves.',
    }
  }

  if (!grade.reachable) {
    return {
      selectable: false,
      badge: 'unknown',
      tone: 'warning',
      title: grade.error ?? 'No inbound listing',
    }
  }

  const ok = role === 'exit' ? grade.exit : grade.entry
  const security = role === 'exit' ? grade.exitSecurity : grade.entrySecurity
  const served = grade.transports.join(', ')

  if (ok) {
    const wrapping = security === 'reality' ? 'Reality' : 'TLS'
    return {
      selectable: true,
      badge: `${role === 'exit' ? 'TCP + ' : ''}${wrapping}`,
      tone: 'success',
      title: `Serves ${served}. This hop would be wrapped in ${wrapping}.`,
    }
  }

  return {
    selectable: false,
    badge: role === 'exit' ? 'no TLS/TCP' : 'no TLS',
    tone: 'danger',
    title: role === 'exit'
      ? `Serves ${served || 'nothing usable'}. A chain exit needs a plain-TCP inbound wrapped in TLS or Reality.`
      : `Serves ${served || 'nothing usable'}, but none of it is wrapped in TLS or Reality. Still fine for an ordinary single-hop connection.`,
  }
}

/**
 * Sort rank for the eligibility column: most useful to this hop first.
 *
 * Ascending is "best first", so a plain ascending sort puts every node you can
 * actually pick at the top. The two that are merely unproven sit above the two that
 * are known to fail, and pre-9.0.0 sorts last because it is the one that cannot be
 * checked at any price.
 *
 * Rank 0 is exactly `chainRowState().selectable`, and the test holds the two together.
 * A pair conflict sorts with the refused, since it is just as final.
 */
export function chainRowRank(
  node: SentNode,
  grade: ChainEligibility | undefined,
  role: ChainRole,
  conflict: PairConflict | null,
): number {
  if (conflict !== null) return 3
  if (!isCheckable(node)) return 4
  if (grade === undefined) return 1
  if (!grade.reachable) return 2
  return (role === 'exit' ? grade.exit : grade.entry) ? 0 : 3
}

/** Whether `grade` confirms this node can serve `role`. Drives "Verified only". */
export function isVerifiedFor(grade: ChainEligibility | undefined, role: ChainRole): boolean {
  if (!grade?.reachable) return false
  return role === 'exit' ? grade.exit : grade.entry
}

/**
 * usable: a click puts the node in this hop. picked: it is there, a click takes it out.
 * clash: refused by the pair rule, which the row states in words (`badge`) rather than
 * behind a hover, the way the rows that cannot show chips already do. refused: any
 * other refusal, explained by `title`.
 */
export type HopChipState =
  | { kind: 'usable' | 'picked' | 'refused'; title: string }
  | { kind: 'clash'; badge: PairConflict['badge']; title: string }

/**
 * One of the two role chips on a row ("Entry", "Exit"), so a node can go straight into
 * either hop without first switching which hop the bar is filling.
 *
 * `picked` is the node already in this role's slot and `other` the one in the other
 * slot; `conflict` is `pairConflict(node, other)`, or null when there is no other hop.
 * Being the pick wins, then being the other hop's pick, then `chainRowState`, so a chip
 * is usable exactly when that row would be selectable for that role: the same positive
 * evidence, never a looser rule for the shortcut.
 *
 * A usable chip for a hop that is already filled REPLACES that hop, and its title says
 * so. Without it, an Australian row next to an Australian entry offered a green "Entry"
 * that read as "this one is fine" when all it could do was swap out the entry.
 */
export function hopChipState(
  node: SentNode,
  grade: ChainEligibility | undefined,
  role: ChainRole,
  picked: SentNode | null,
  other: SentNode | null,
  conflict: PairConflict | null,
): HopChipState {
  if (picked?.address === node.address) return { kind: 'picked', title: `Your ${role}. Click to remove it.` }
  if (other?.address === node.address) {
    return { kind: 'refused', title: `Already your ${role === 'entry' ? 'exit' : 'entry'}.` }
  }
  const state = chainRowState(node, grade, role, conflict)
  if (conflict !== null) return { kind: 'clash', badge: conflict.badge, title: state.title }
  if (!state.selectable) return { kind: 'refused', title: state.title }
  return {
    kind: 'usable',
    title: picked ? `Replaces ${picked.moniker || picked.address} as your ${role}. ${state.title}` : state.title,
  }
}

/**
 * Why the two hops cannot trade places, or null when they can. Every node that moves
 * must be verified for the role it moves into, on the same positive evidence as a
 * click on its row. The pair rule needs no check here: it is symmetric.
 */
export function swapBlocker(
  entry: SentNode | null,
  exit: SentNode | null,
  grades: ReadonlyMap<string, ChainEligibility>,
): string | null {
  const name = (n: SentNode) => n.moniker || n.address
  if (entry && !isVerifiedFor(grades.get(entry.address), 'exit')) {
    return `${name(entry)} is not verified as an exit, so the hops cannot swap.`
  }
  if (exit && !isVerifiedFor(grades.get(exit.address), 'entry')) {
    return `${name(exit)} is not verified as an entry, so the hops cannot swap.`
  }
  return null
}

/**
 * "Pick for me": the best entry and exit among `nodes` (what the user's
 * filters show), or null when no two of them make a chain.
 *
 * Admits on positive evidence only, like the rows: both ends verified for their role
 * by a reachable grade, both quoting a udvpn price for `billing`, and no pair
 * conflict between them (`conflict` is `pairConflict`). Ranked by latency first,
 * since a chain is already about 20x slower than one hop: pairs with both latencies
 * measured, then the lower sum, then the lower total price, then the two addresses,
 * so the same list always gives the same answer.
 *
 * The conflict check is the one costly step, so it runs only for a pair that would
 * beat the best found so far, and both lists are walked fastest first so a good pair
 * turns up early and most of the rest fail on the numbers alone.
 */
export function pickChainPair(
  nodes: SentNode[],
  grades: ReadonlyMap<string, ChainEligibility>,
  latency: ReadonlyMap<string, number | null>,
  billing: BillingType,
  conflict: (a: SentNode, b: SentNode) => PairConflict | null,
): { entry: SentNode; exit: SentNode } | null {
  interface Candidate { node: SentNode; ms: number | null; price: number }
  const candidates = (role: ChainRole): Candidate[] => {
    const out: Candidate[] = []
    for (const node of nodes) {
      const price = udvpnPrice(node, billing)
      if (price === null || !isVerifiedFor(grades.get(node.address), role)) continue
      out.push({ node, ms: latency.get(node.address) ?? null, price })
    }
    return out.sort((a, b) => Number(a.ms === null) - Number(b.ms === null) || (a.ms ?? 0) - (b.ms ?? 0))
  }

  interface Score { unmeasured: number; ms: number; price: number; key: string }
  const better = (a: Score, b: Score): boolean =>
    a.unmeasured !== b.unmeasured ? a.unmeasured < b.unmeasured
      : a.ms !== b.ms ? a.ms < b.ms
        : a.price !== b.price ? a.price < b.price
          : a.key < b.key

  const exits = candidates('exit')
  let best: { entry: SentNode; exit: SentNode; score: Score } | null = null
  for (const e of candidates('entry')) {
    for (const x of exits) {
      if (e.node.address === x.node.address) continue
      const score: Score = {
        unmeasured: Number(e.ms === null) + Number(x.ms === null),
        ms: (e.ms ?? 0) + (x.ms ?? 0),
        price: e.price + x.price,
        key: `${e.node.address} ${x.node.address}`,
      }
      if (best !== null && !better(score, best.score)) continue
      if (conflict(e.node, x.node) !== null) continue
      best = { entry: e.node, exit: x.node, score }
    }
  }
  return best === null ? null : { entry: best.entry, exit: best.exit }
}

/**
 * What stands between the review and Pay. The modal words each one. A live connection
 * is not one: Pay leaves it first ([RN-10]).
 */
export type ChainBlocker =
  | 'pair'
  | 'exit-refused'
  | 'no-wallet'
  | 'wallet-linked'
  | 'wallet-checking'
  | 'price-missing'
  | 'entry-short'
  | 'exit-short'
  | 'unacknowledged'

export interface ChainBuyState {
  /** `pairConflict(entry, exit)`. The picker already refuses these; this is the backstop. */
  conflict: PairConflict | null
  /** The exit's grade is a definite no. */
  exitRefused: boolean
  /** The second wallet and its link check. 'none' = no second wallet chosen or available. */
  exitWallet: 'none' | 'checking' | 'linked' | 'unchecked' | 'clean'
  priceMissing: boolean
  entryShort: boolean
  exitShort: boolean
  acknowledged: boolean
}

/**
 * Why Pay is disabled, or null when it is not. ONE reason, the first in this order,
 * so the footer can always name it: a disabled button used to explain one of its six
 * conditions. The order runs from what the user must leave this window to fix to
 * what one click here fixes, the checkbox last.
 *
 * Two wallets are required (decided 2026-10-05): with one, either node can read the
 * account off its own session and find the other hop with a public query. A wallet
 * visibly funded from the active one blocks for the same reason. A link check that
 * could not RUN does not block: that is the RPC lacking a transaction index, not a
 * finding, and blocking on it would lock out everyone on such an endpoint. The modal
 * still says it could not check, in amber, never as a pass.
 */
export function chainBuyBlocker(s: ChainBuyState): ChainBlocker | null {
  if (s.conflict !== null) return 'pair'
  if (s.exitRefused) return 'exit-refused'
  if (s.exitWallet === 'none') return 'no-wallet'
  if (s.exitWallet === 'linked') return 'wallet-linked'
  if (s.exitWallet === 'checking') return 'wallet-checking'
  if (s.priceMissing) return 'price-missing'
  if (s.entryShort) return 'entry-short'
  if (s.exitShort) return 'exit-short'
  if (!s.acknowledged) return 'unacknowledged'
  return null
}
