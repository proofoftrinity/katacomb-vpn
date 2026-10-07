import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, WALLET_ADDRESS, T0, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, merge, worldFor, NODE_WG, NODE_ENTRY, NODE_EXIT } from '../../test/harness/requests.ts'

// Signed replies and the two-hop chain's privacy rules (docs/invariants/node-trust.md,
// docs/multihop.md): what main asks of which node, through what, signed by whom.

const ipc = await loadIpcHandlers()

const node = (address: string, version: string, type = 1) =>
  ({ address, moniker: address.slice(-2), country: 'DE', type, api: 'https://203.0.113.7:8585', isActive: true, isHealthy: true, version })

const chainWorld = (extra: FreshOptions = {}): FreshOptions => merge(worldFor('CONNECTION_SUBSCRIBE_CHAIN'), extra)

describe('[NT-5] every handshake asks for a signed reply when the directory says the node signs', () => {
  for (const [version, expected] of [['9.4.0', true], ['9.3.2', false]] as const) {
    test(`[NT-5] a single-hop purchase of a ${version} node passes requireSigned: ${expected}`, async (t) => {
      const h = ipc.fresh({ nodes: [node(NODE_WG, version)] })
      t.after(() => h.dispose())
      await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
      const [call] = h.calls('chain/chain-service', 'performHandshake')
      assert.equal((call.args[0] as { requireSigned: boolean }).requireSigned, expected)
    })
  }

  test('[NT-5] a reconnect\'s renewal handshake asks for a signature too', async (t) => {
    const h = ipc.fresh({
      nodes: [node(NODE_WG, '9.4.1')],
      fakes: { 'chain/chain-service': { loadSessionConfig: (id: string) => ({ sessionId: id, nodeAddress: NODE_WG, protocol: 'wireguard', configString: 'cfg' }) as never } },
    })
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_RECONNECT', { sessionId: '2001' }))
    const [call] = h.calls('chain/chain-service', 'performHandshake')
    assert.equal((call.args[0] as { requireSigned: boolean }).requireSigned, true)
  })

  test('[NT-5] both hops of a chain ask, each by its own directory entry', async (t) => {
    const h = ipc.fresh(chainWorld({ nodes: [node(NODE_ENTRY, '9.4.0', 2), node(NODE_EXIT, '9.2.0', 2)] }))
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.equal(h.calls('chain/chain-service', 'handshakeChainEntry')[0].args[2], true)
    assert.equal(h.calls('chain/chain-service', 'handshakeChainExit')[0].args[2], false)
  })
})

describe('the chain never shows the exit hop who the user is', () => {
  const stops = (h: IpcHarness) => h.world.log.filter((c) => c.fn === 'proxy.stop').length
  const withProxy = (extra: FreshOptions = {}): FreshOptions => chainWorld(merge(extra, { fakes: { 'vpn/vpn-manager': {
    startProvisioningProxy: async () => ({ port: 1081, stop: () => { globalThis.__kvWorld!.log.push({ mod: 'test', fn: 'proxy.stop', args: [], seq: -1 }) } }) as never,
  } } }))

  test('[MH-13] the exit is checked and handshaked only through the entry\'s proxy, and the proxy is stopped', async (t) => {
    const h = ipc.fresh(withProxy())
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    const exitApi = (REQUEST.CONNECTION_SUBSCRIBE_CHAIN.exit as { apiField: string }).apiField
    const asked = h.world.log.filter((c) => c.mod === 'nodes/node-tester' && c.args[0] === exitApi)
    assert.ok(asked.length >= 2, 'the exit is preflighted and graded before it is bought')
    assert.deepEqual(asked.filter((c) => !c.args[1]).map((c) => c.fn), [], 'every question to the exit carries the entry proxy agent')
    const entryAsked = h.world.log.filter((c) => c.mod === 'nodes/node-tester' && c.args[0] !== exitApi)
    assert.deepEqual(entryAsked.filter((c) => c.args[1]).map((c) => c.fn), [], 'the entry is asked directly')
    assert.ok(h.calls('chain/chain-service', 'handshakeChainExit')[0].args[3], 'the exit handshake rides the proxy')
    assert.equal(stops(h), 1)
  })

  test('[MH-13] the provisioning proxy is stopped when the exit fails too', async (t) => {
    const h = ipc.fresh(withProxy({ fakes: { 'chain/chain-service': { handshakeChainExit: async () => { throw new Error('exit down') } } } }))
    t.after(() => h.dispose())
    await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.equal(stops(h), 1)
  })

  test('[MH-18] both hops carry the wallet that paid for them', async (t) => {
    const h = ipc.fresh(chainWorld())
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.equal((h.calls('chain/chain-service', 'handshakeChainEntry')[0].args[0] as { walletId: string }).walletId, 'w1')
    assert.equal((h.calls('chain/chain-service', 'handshakeChainExit')[0].args[0] as { walletId: string }).walletId, 'w2')
  })

  test('[MH-7] the exit cannot be paid from the active wallet: refused before anything is spent', async (t) => {
    const h = ipc.fresh(chainWorld())
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', { ...REQUEST.CONNECTION_SUBSCRIBE_CHAIN, exitWalletId: 'w1' }))
    assert.match(err.message, /second wallet.*Nothing was charged/s)
    assert.deepEqual(h.calls('chain/chain-service', 'subscribeToNode'), [])
  })

  test('[MH-7] nor from the same account stored under another id, and that key is wiped', async (t) => {
    const key = new Uint8Array(32).fill(9)
    const h = ipc.fresh(chainWorld({ fakes: { 'chain/wallet': {
      loadWalletCredentials: async () => ({ wallet: { fake: 'same' }, address: WALLET_ADDRESS, privKey: key }) as never,
    } } }))
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.match(err.message, /second wallet/)
    assert.deepEqual(h.calls('chain/chain-service', 'subscribeToNode'), [])
    assert.ok(key.every((b) => b === 0), 'the second wallet\'s derived key is zeroed')
  })

  test('[MH-7] the exit wallet\'s key is zeroed after a successful chain as well', async (t) => {
    const key = new Uint8Array(32).fill(9)
    const h = ipc.fresh(chainWorld({ fakes: { 'chain/wallet': {
      loadWalletCredentials: async () => ({ wallet: { fake: 'exit-wallet' }, address: 'sent1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqexit', privKey: key }) as never,
    } } }))
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.ok(key.every((b) => b === 0))
  })

  test('[MH-11] a reconnected chain reports the nodes\' own protocol, not the xray runtime', async (t) => {
    const h = ipc.fresh({ fakes: { 'chain/chain-service': {
      loadSessionConfig: (id: string) => ({
        sessionId: id, nodeAddress: id === '3001' ? NODE_ENTRY : NODE_EXIT, protocol: 'xray', configString: 'cfg-chain', nodeType: 2,
        chainPeerSessionId: id === '3001' ? '3002' : '3001', chainRole: id === '3001' ? 'entry' : 'exit',
      }) as never,
    } } })
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_RECONNECT', { sessionId: '3002' }))
    const s = await h.settle(h.invoke('CONNECTION_STATUS')) as { nodeType: number; nodeAddress: string }
    assert.equal(s.nodeType, 2)
    assert.equal(s.nodeAddress, NODE_ENTRY, 'clicking the exit hop still makes the entry the entry')
  })
})

describe('[MH-5] each hop is graded before it is bought, and a refusal buys nothing', () => {
  // A vless/tcp inbound with no TLS: fine for a single hop, no use as either end of a chain.
  const PLAIN = { port: '', proxy_protocol: 1, transport_protocol: 7, transport_security: 1 }
  const TLS = { port: '', proxy_protocol: 1, transport_protocol: 7, transport_security: 2 }
  const listing = (entry: unknown[] | Error, exit: unknown[] | Error): FreshOptions => ({ fakes: { 'nodes/node-tester': {
    fetchNodeServiceMetadata: async (api: string) => {
      const answer = api.includes('entry') ? entry : exit
      if (answer instanceof Error) throw answer
      return answer as never
    },
  } } })
  const bought = (h: IpcHarness) => h.calls('chain/chain-service', 'subscribeToNode').map((c) => (c.args[0] as { nodeAddress: string }).nodeAddress)

  test('[MH-5] an entry that cannot be wrapped in TLS is refused before anything is bought', async (t) => {
    const h = ipc.fresh(chainWorld(listing([PLAIN], [TLS])))
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.match(err.message, /not charged/)
    assert.deepEqual(bought(h), [])
  })

  test('[MH-5] a pre-9.0.0 entry that publishes no listing is refused, not bought and refunded', async (t) => {
    const h = ipc.fresh(chainWorld(listing(new Error('404'), [TLS])))
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.match(err.message, /not charged.*9\.0\.0/s)
    assert.deepEqual(bought(h), [])
  })

  test('[MH-5] an exit that fails its grading (asked through the entry) is never bought; the entry is refunded', async (t) => {
    const h = ipc.fresh(chainWorld(listing([TLS], [PLAIN])))
    t.after(() => h.dispose())
    await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.deepEqual(bought(h), [NODE_ENTRY], 'only the entry, which the exit has to be asked through')
    assert.deepEqual(h.calls('chain/chain-service', 'endSession').map((c) => (c.args[0] as { sessionId: string }).sessionId), ['1001'])
  })
})

describe('[MH-12] the exit never proves, so the chain has a deadline: warned before it, stood down after it only if dead', () => {
  const row = (id: string, inactiveAtMs: number) => ({
    id, nodeAddress: id === '1001' ? NODE_ENTRY : NODE_EXIT, status: 'active', downloadBytes: '0', uploadBytes: '0',
    maxBytes: String(1024 ** 3), durationSeconds: 0, maxDurationSeconds: null, inactiveAt: new Date(inactiveAtMs).toISOString(),
    startAt: new Date(T0).toISOString(), subscriptionId: null, priceDenom: 'udvpn', priceValue: '5000000',
  })
  const DEADLINE = T0 + 20 * 60_000 // the exit's inactiveAt: purchase + statusTimeout, never moved
  async function chainUp(h: IpcHarness): Promise<void> {
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'xray' }))
    assert.equal(h.tunnel.up, true)
  }
  const world = () => chainWorld({ chainSessions: [row('1001', T0 + 3 * 3600_000), row('1002', DEADLINE)] })
  const warnings = (h: IpcHarness) => h.world.notifications.filter((n) => /chain stops in about/.test(n.body ?? ''))

  test('[MH-12] one warning inside the last ten minutes; past the deadline, a tunnel carrying nothing is stood down as hop-closed', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await chainUp(h)
    await h.advance(DEADLINE - 11 * 60_000 - Date.now())
    assert.deepEqual(warnings(h), [], 'nothing yet, eleven minutes out')
    await h.advance(2 * 60_000)
    assert.equal(warnings(h).length, 1)
    await h.advance(5 * 60_000)
    assert.equal(warnings(h).length, 1, 'warned once, not on every tick')
    assert.equal(h.tunnel.up, true, 'nothing torn down before the deadline')
    await h.advance(DEADLINE + 30_000 - Date.now()) // the chain's EndBlocker has had its slack
    h.tunnel.carries = false
    await h.advance(60_000)
    assert.equal(h.tunnel.up, false)
    const status = await h.settle(h.invoke('CONNECTION_STATUS')) as { expired?: { reason: string; chainRole?: string } }
    assert.deepEqual([status.expired?.reason, status.expired?.chainRole], ['hop-closed', 'exit'])
  })

  test('[MH-12] control: past the deadline, a chain still carrying traffic is left alone (the exit proved after all)', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await chainUp(h)
    await h.advance(DEADLINE + 5 * 60_000 - Date.now())
    assert.equal(h.tunnel.up, true)
    const status = await h.settle(h.invoke('CONNECTION_STATUS')) as { state: string; expired?: unknown }
    assert.deepEqual([status.state, status.expired], ['connected', undefined])
  })
})
