import type { FakesFor, FreshOptions } from './ipc.ts'
import type { SPEND } from './entry-points.ts'

// One valid request per purchase handler, and the world each one needs to get as far
// as the money: the shared inputs for every matrix that loops over SPEND.

export const NODE_WG = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwg'
export const NODE_ENTRY = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqen'
export const NODE_EXIT = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqex'
export const EXIT_WALLET_ADDRESS = 'sent1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqexit'

const single = { nodeMoniker: 'node-wg', nodeCountry: 'DE', nodeType: 1, apiField: 'https://203.0.113.7:8585' }
const hop = (nodeAddress: string, moniker: string) => ({
  nodeAddress, nodeMoniker: moniker, nodeCountry: moniker === 'entry' ? 'NL' : 'JP', nodeType: 2,
  apiField: `https://${moniker}.example:8585`, quoteValue: '5000000',
})

export const REQUEST: Record<(typeof SPEND)[number], Record<string, unknown>> = {
  CONNECTION_SUBSCRIBE: { nodeAddress: NODE_WG, ...single, type: 'gigabytes', amount: 1, denom: 'udvpn', quoteValue: '5000000' },
  CONNECTION_SUBSCRIBE_CHAIN: {
    entry: hop(NODE_ENTRY, 'entry'), exit: hop(NODE_EXIT, 'exit'),
    type: 'gigabytes', amount: 1, denom: 'udvpn', exitWalletId: 'w2',
  },
  PLAN_SUBSCRIBE: { planId: '42', denom: 'udvpn', nodeAddress: NODE_WG, ...single },
  PLAN_START_SESSION_FROM_SUB: { subscriptionId: '77', planId: '42', nodeAddress: NODE_WG, ...single },
  PLAN_SMART_CONNECT: { planId: '42', subscriptionId: '77' },
}

// What a hop's handshake yields: the inbound with its real port and pin, and the
// node's address. Real enough for multihop-config, which stays unfaked.
const hopSpec = (role: 'entry' | 'exit') => ({
  protocol: 'v2ray',
  metadata: [{ port: role === 'entry' ? '18407' : '4876', proxy_protocol: 1, transport_protocol: 7, transport_security: 2, tls_pin: (role === 'entry' ? 'b' : '9').repeat(64) }],
  addrs: [role === 'entry' ? '198.51.100.10' : '198.51.100.20'],
  uuid: role === 'entry' ? '11111111-2222-3333-4444-555555555555' : '99999999-8888-7777-6666-555555555555',
})

// A vless/tcp/tls inbound as a node's root document lists it: usable at both ends.
const CHAIN_INBOUND = { port: '', proxy_protocol: 1, transport_protocol: 7, transport_security: 2 }

/** Everything beyond the defaults a purchase handler needs to reach its purchase. */
export function worldFor(key: (typeof SPEND)[number]): FreshOptions {
  if (key === 'CONNECTION_SUBSCRIBE_CHAIN') {
    return {
      walletsIndex: [
        { id: 'w1', name: 'Main', address: 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu' },
        { id: 'w2', name: 'Second', address: EXIT_WALLET_ADDRESS },
      ],
      fakes: {
        'nodes/node-tester': {
          // The two chain hops are V2Ray; anything else in the world stays WireGuard.
          fetchNodeServiceType: async (api: string) => (api.includes('.example') ? 'v2ray' : 'wireguard'),
          fetchNodeServiceMetadata: async () => [CHAIN_INBOUND],
        },
        'chain/wallet': {
          loadWalletCredentials: async () => ({ wallet: { fake: 'exit-wallet' }, address: EXIT_WALLET_ADDRESS, privKey: new Uint8Array(32).fill(9) }) as never,
        },
        'chain/chain-service': {
          handshakeChainEntry: async () => ({ ...hopSpec('entry'), signer: null }) as never,
          handshakeChainExit: async () => ({ ...hopSpec('exit'), signer: null }) as never,
          finalizeChain: async () => ({ protocol: 'xray', configString: 'cfg-chain' }) as never,
        },
      } satisfies FakesFor,
    }
  }
  if (key === 'PLAN_SMART_CONNECT') {
    return {
      nodes: [{ address: NODE_WG, moniker: 'node-wg', country: 'DE', type: 1, api: 'https://203.0.113.7:8585', isActive: true, isHealthy: true, version: '9.3.0' }],
      fakes: {
        'plans/plan-service': { listNodesForPlan: async () => [NODE_WG] },
        'nodes/node-tester': { probeNode: async () => ({ reachable: true, latencyMs: 40 }) as never },
      } satisfies FakesFor,
    }
  }
  return {}
}

/** Merge two worlds' options, the second winning per faked function. */
export function merge(a: FreshOptions, b: FreshOptions): FreshOptions {
  const fakes: Record<string, Record<string, unknown>> = {}
  for (const src of [a.fakes ?? {}, b.fakes ?? {}]) {
    for (const [mod, fns] of Object.entries(src)) fakes[mod] = { ...fakes[mod], ...(fns as Record<string, unknown>) }
  }
  return { ...a, ...b, fakes: fakes as FakesFor }
}
