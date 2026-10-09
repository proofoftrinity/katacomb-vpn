import { TimeoutError } from '@cosmjs/stargate'

// Inlined rather than imported from '../../shared/error-markers': Node's native test
// runner can't resolve extensionless relative imports, so a unit-tested main module
// can't have them (same constraint that keeps connect-decisions.ts import-free).
// `tx-utils.test.ts` asserts this stays equal to the exported INSUFFICIENT_FUNDS.
const INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS'

/**
 * The Cosmos SDK error code (default codespace) that means "this wallet can't pay":
 * 5 = insufficient funds. Not 11 (out of gas: the tx outran its own gas limit) and
 * not 13 (insufficient fee: the fee offered is under the node's minimum gas price).
 * Neither is about the balance and a top-up fixes neither, yet both were once
 * reported as "not enough P2P". The codespace isn't checked because the dVPN modules
 * don't reuse the code.
 */
const FUNDS_CODE = 5
const OUT_OF_GAS_CODE = 11

const FUNDS_LOG_RE = /insufficient funds/i

/**
 * Does this chain response/error mean the wallet couldn't cover the tx? Matches
 * on the code when there is one, and on the log text either way — CosmJS
 * simulates before broadcasting (gas: 'auto'), so an unaffordable tx often
 * throws with the reason in the message and never yields a code at all.
 */
export function isInsufficientFundsFailure(code: number | undefined, log: string): boolean {
  if (code === FUNDS_CODE) return true
  return FUNDS_LOG_RE.test(log)
}

/**
 * Did a query fail because the record simply isn't there?
 *
 * The hub answers a missing single-record lookup (provider, node, plan) with gRPC
 * NotFound = 22, which CosmJS raises as a thrown Error rather than an empty
 * result — so "have I registered yet?" reads as a failure unless it's translated.
 * Matched on both the numeric code and the text because the two arrive by
 * different routes (ABCI response code vs. the wrapped rpc error string).
 */
export function isChainNotFound(message: string): boolean {
  return /Query failed with \(22\)|code = NotFound/.test(message)
}

/**
 * Did MsgCancelSession fail because the session had ALREADY stopped being active?
 *
 * A session that runs out of its paid quota moves active(1) → inactive_pending(2)
 * on chain by itself, and x/session only accepts a cancel in status 1 — so the
 * user clicking "End" a moment too late gets a raw `rawLog` for something that has
 * in fact already happened. Narrow on purpose: only the status guard, so a real
 * rejection (bad signature, wrong owner, unknown id) still throws.
 */
export function isSessionNotActive(message: string): boolean {
  return /invalid session status|invalid status \w+ for session/.test(message)
}

/** For a tx refused before it reached a block (the gas simulation, CheckTx), which charges nothing. */
export const FUNDS_MESSAGE =
  `${INSUFFICIENT_FUNDS}: The transaction was rejected: your wallet doesn't have enough P2P ` +
  `to cover it plus the network fee. Nothing was charged. Top up your wallet and try again.`

/**
 * Throw unless the tx landed.
 *
 * A result that carries a code was included in a block, where the ante handler takes
 * the fee and commits before the msgs run: the fee is normally gone, so nothing here
 * says "nothing was charged". An insufficient-funds failure gets the marked,
 * user-readable message; running out of gas says what happened to the fee; everything
 * else keeps the raw `code`/`rawLog` (the only diagnostic we have for an unexpected
 * chain rejection).
 */
export function assertTxSucceeded(tx: { code: number; rawLog?: string }, label: string): void {
  if (tx.code === 0) return
  if (isInsufficientFundsFailure(tx.code, tx.rawLog ?? '')) {
    throw new Error(
      `${INSUFFICIENT_FUNDS}: The transaction failed: your wallet doesn't have enough P2P to cover it. ` +
      'Top up your wallet and try again.',
    )
  }
  if (tx.code === OUT_OF_GAS_CODE) {
    throw new Error(
      `${label} ran out of gas and was not applied, though its network fee may still have been charged. ` +
      `Try again. (code ${tx.code}: ${tx.rawLog})`,
    )
  }
  throw new Error(`${label} failed with code ${tx.code}: ${tx.rawLog}`)
}

/**
 * Wrap a session-creating broadcast so a CosmJS `TimeoutError` (the tx wasn't
 * confirmed within the client's poll window) becomes an actionable, money-aware
 * message instead of a raw error. The tx MAY still land, so the message points the
 * user at the Session tab to cancel any unexpected session (finding H2). Where a
 * `timeoutHeight` is also set on the broadcast, the chain additionally rejects a
 * tx that misses the window, bounding the late-landing risk.
 *
 * A pre-broadcast insufficient-funds rejection (thrown by the gas simulation) is
 * translated here too — `assertTxSucceeded` never sees it, there's no tx.
 */
export async function broadcastOrTimeout<T>(p: Promise<T>, timeoutMessage: string): Promise<T> {
  try {
    return await p
  } catch (err) {
    if (err instanceof TimeoutError) throw new Error(timeoutMessage)
    if (err instanceof Error && isInsufficientFundsFailure(undefined, err.message)) {
      throw new Error(FUNDS_MESSAGE)
    }
    throw err
  }
}
