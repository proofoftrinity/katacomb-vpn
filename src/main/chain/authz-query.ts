// The one authz question the app asks: has a node account granted a key the right to
// send the node's messages? A dvpnd node may sign its handshake reply with such a
// "hot key" instead of the node account's own (see protocols/reply-signature.ts), and
// that key speaks for the node only while the grant stands.

import { QueryClient, setupAuthzExtension } from '@cosmjs/stargate'
import { connectComet, type CometClient } from '@cosmjs/tendermint-rpc'
import { getRpcEndpoint } from '../settings'
import { withTimeout } from '../async-utils'
import { resolveRpcBase } from './chain-clients'
import { QUERY_TIMEOUT_MS } from './protobuf-query'
import { NODE_STATUS_MSG_TYPE } from '../protocols/reply-signature'

const CONNECT_TIMEOUT_MS = 10_000

/**
 * The chain's answer when no grant exists: asked for one message type, it fails the
 * query instead of returning an empty list. Observed on mainnet (cosmos-sdk 0.47):
 * "Query failed with (6): authorization not found for <type> type: authorization not
 * found: unknown request".
 */
const NO_GRANT = /authorization not found/

/**
 * True when `granter` (the node account, sent1…) holds an unexpired grant to `grantee`
 * for MsgUpdateNodeStatusRequest, false when it holds none. Throws when the chain
 * cannot be asked: an unanswered question is not a grant, and the caller refuses the
 * reply rather than guess.
 */
export async function hasNodeStatusGrant(granter: string, grantee: string): Promise<boolean> {
  let comet: CometClient | null = null
  try {
    const base = await resolveRpcBase(getRpcEndpoint())
    comet = await withTimeout(connectComet(base), CONNECT_TIMEOUT_MS, 'RPC connect')
    const query = QueryClient.withExtensions(comet, setupAuthzExtension)
    const { grants } = await withTimeout(
      query.authz.grants(granter, grantee, NODE_STATUS_MSG_TYPE),
      QUERY_TIMEOUT_MS,
      'authz grant query',
    )
    const now = Date.now()
    return grants.some((g) => !g.expiration || Number(g.expiration.seconds) * 1000 > now)
  } catch (err) {
    if (err instanceof Error && NO_GRANT.test(err.message)) return false
    throw err
  } finally {
    comet?.disconnect()
  }
}
