import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isJsonRpcErrorResponse, parseJsonRpcResponse, type JsonRpcRequest, type JsonRpcSuccessResponse } from '@cosmjs/json-rpc'
import {
  Comet1Client,
  Comet38Client,
  Tendermint37Client,
  connectComet,
  type CometClient,
  type RpcClient,
} from '@cosmjs/tendermint-rpc'
import {
  GasPrice,
  QueryClient,
  createProtobufRpcClient,
  type ProtobufRpcClient,
  type SigningStargateClientOptions,
} from '@cosmjs/stargate'
import type { OfflineSigner } from '@cosmjs/proto-signing'
import { SentinelClient, SigningSentinelClient } from '@sentinel-official/sentinel-js-sdk'
import { CHAIN_REGISTRY } from '../provider/provider-msgs'
import { getRpcEndpoint } from '../settings'
import { withTimeout } from '../async-utils'
import { GAS_PRICE_STR } from './chain-constants'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
const RPC_CONNECT_TIMEOUT_MS = 10_000
const REDIRECT_PROBE_TIMEOUT_MS = 3_000
const FRESH_REQUEST_TIMEOUT_MS = 10_000
const FRESH_MAX_REDIRECTS = 3
/**
 * How often the signing client re-checks whether a broadcast tx has committed.
 * CosmJS's default is 3000ms and it sleeps BEFORE the first check, so with
 * Sentinel's ~3.6s blocks the default discovers an included tx ~1.5s late on
 * average. 1s costs a couple of extra getTx queries and returns that time to
 * the user on every paid connect.
 */
export const TX_POLL_INTERVAL_MS = 1_000

/**
 * The RPC base each configured endpoint actually serves from, discovered once
 * per launch (per endpoint string, so changing the setting re-resolves).
 *
 * The default endpoint (rpc.sentinel.co) 307-redirects EVERY request to another
 * host (~100ms extra per request, measured; a connect flow makes ~20 requests).
 * Following the redirect once and talking to the target directly returns that
 * time while the user-facing setting keeps the official, stable name — the
 * target is a runtime detail, re-discovered at next launch, never persisted and
 * never shown in the UI. Fail-open: any probe failure means "use the endpoint
 * as configured", which is exactly today's behavior.
 */
const resolvedBases = new Map<string, Promise<string>>()

export function resolveRpcBase(endpoint: string): Promise<string> {
  let pending = resolvedBases.get(endpoint)
  if (!pending) {
    pending = discoverRedirect(endpoint)
    resolvedBases.set(endpoint, pending)
  }
  return pending
}

async function discoverRedirect(endpoint: string): Promise<string> {
  try {
    const res = await fetch(endpoint, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REDIRECT_PROBE_TIMEOUT_MS),
    })
    if (res.status !== 307 && res.status !== 308) return endpoint
    const location = res.headers.get('location')
    if (!location) return endpoint
    // Only ever follow to another https host. The Location for the probed URL is
    // the new base itself (we probe the endpoint exactly as configured, so a
    // path-prefixed endpoint keeps its prefix in the target).
    const target = new URL(location, endpoint)
    if (target.protocol !== 'https:') return endpoint
    const base = target.href.replace(/\/$/, '')
    if (new URL(base).origin === new URL(endpoint).origin) return endpoint
    console.log(`[rpc] ${new URL(endpoint).host} redirects to ${target.host}, using it directly this session`)
    return base
  } catch {
    return endpoint
  }
}

/**
 * JSON-RPC over a new socket for every request, for the chain calls right after Extend
 * moves the tunnel ([REL-46]). CosmJS's HttpClient posts through the global fetch, whose
 * keep-alive pool can hand it a socket opened through the tunnel that just went. After a
 * WireGuard switch the peer has a new address, so that socket's packets get no answer
 * and nothing closes it: the request hangs until the caller gives up. Seen on mainnet
 * 2026-11-04, the first End after a WireGuard switch hung for its whole 10 s connect.
 * The same trap as fetchFreshSocket's (net-fetch.ts). Errors read as HttpClient's do,
 * since callers match on them (isSessionNotActive, isRpcConnectivityError).
 */
class FreshSocketRpcClient implements RpcClient {
  private readonly url: string

  constructor(url: string) {
    this.url = url
  }

  disconnect(): void {
    // Nothing is kept open between requests.
  }

  async execute(request: JsonRpcRequest): Promise<JsonRpcSuccessResponse> {
    const response = parseJsonRpcResponse(await postFreshSocket(this.url, JSON.stringify(request), FRESH_MAX_REDIRECTS))
    if (isJsonRpcErrorResponse(response)) throw new Error(JSON.stringify(response.error))
    return response
  }
}

/**
 * POST on a socket of its own (`agent: false`). Follows a 307/308 as fetch does, since
 * resolveRpcBase is fail-open and the default endpoint redirects every request, but
 * never from https down to plain http.
 */
function postFreshSocket(url: string, body: string, redirectsLeft: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(target, {
      method: 'POST',
      agent: false,
      signal: AbortSignal.timeout(FRESH_REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if ((status === 307 || status === 308) && location && redirectsLeft > 0) {
        const next = new URL(location, target)
        if (next.protocol === 'https:' || next.protocol === target.protocol) {
          res.resume()
          resolve(postFreshSocket(next.href, body, redirectsLeft - 1))
          return
        }
      }
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('error', reject)
      res.on('end', () => {
        if (status >= 400) {
          reject(new Error(`Bad status on response: ${status}`, { cause: { status, body: text } }))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** connectComet's version detection, over FreshSocketRpcClient. */
async function connectCometFresh(base: string): Promise<CometClient> {
  const rpc = new FreshSocketRpcClient(base)
  const tm37Client = Tendermint37Client.create(rpc)
  const version = (await tm37Client.status()).nodeInfo.version
  if (version.startsWith('0.38.')) return Comet38Client.create(rpc)
  if (version.startsWith('1.')) return Comet1Client.create(rpc)
  return tm37Client
}

/** `freshSockets`: every request on a socket of its own (FreshSocketRpcClient). */
interface ChainFlowOptions {
  freshSockets?: boolean
}

// The SDK's constructors are protected (its static factories are the public
// surface), but the factories create one CometBFT connection each — and a
// connect flow needs a query client AND a signing client, which would cost two
// TLS connections and two status() version probes. These subclasses re-open the
// constructors so both clients can share ONE connection.
class FlowQueryClient extends SentinelClient {
  constructor(tmClient: CometClient) {
    super(tmClient)
  }
}

class FlowSigningClient extends SigningSentinelClient {
  constructor(tmClient: CometClient, signer: OfflineSigner, options: SigningStargateClientOptions) {
    super(tmClient, signer, options)
  }
}

/**
 * One RPC connection for one connect flow: a query client and a signing client
 * over the same CometBFT client, against the redirect-resolved base.
 *
 * Ownership: the handler that opened the flow calls `disconnect()` in its
 * `finally`; anything the flow's clients are passed to must never disconnect
 * them. Scope: the connect flows and the plan/subscription operations — the
 * few remaining one-shot reads elsewhere wrap their endpoint in
 * `resolveRpcBase` instead.
 */
export interface ChainFlow {
  query: SentinelClient
  signing: SigningSentinelClient
  disconnect: () => void
}

/**
 * The read-only sibling of `openChainFlow`: one query client against the
 * redirect-resolved base, for handlers that batch several chain reads. Same
 * ownership rule — the opener disconnects; anything handed the client must
 * never disconnect it.
 */
export interface ChainQuery {
  query: SentinelClient
  /**
   * The same connection for query services the SDK doesn't wrap (x/lease, the v3
   * params services) — what withProtobufQuery builds per call, minus the extra
   * connection. See protobuf-query.ts for why those services need this route.
   */
  protobufRpc: ProtobufRpcClient
  disconnect: () => void
}

export async function openChainQuery(options: ChainFlowOptions = {}): Promise<ChainQuery> {
  const base = await resolveRpcBase(getRpcEndpoint())
  const tmClient = await withTimeout(options.freshSockets ? connectCometFresh(base) : connectComet(base), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  return {
    query: new FlowQueryClient(tmClient),
    protobufRpc: createProtobufRpcClient(QueryClient.withExtensions(tmClient)),
    disconnect: () => tmClient.disconnect(),
  }
}

export async function openChainFlow(wallet: OfflineSigner, options: ChainFlowOptions = {}): Promise<ChainFlow> {
  const base = await resolveRpcBase(getRpcEndpoint())
  const tmClient = await withTimeout(options.freshSockets ? connectCometFresh(base) : connectComet(base), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  return {
    query: new FlowQueryClient(tmClient),
    signing: new FlowSigningClient(tmClient, wallet, {
      // The static factory injects a registry itself; constructing directly skips
      // that, and without it every sentinel msg fails to encode. CHAIN_REGISTRY is
      // the app-wide one: the SDK own list omits x/lease and MsgUpdatePlanDetails.
      registry: CHAIN_REGISTRY,
      gasPrice: GAS_PRICE,
      broadcastPollIntervalMs: TX_POLL_INTERVAL_MS,
    }),
    disconnect: () => tmClient.disconnect(),
  }
}
