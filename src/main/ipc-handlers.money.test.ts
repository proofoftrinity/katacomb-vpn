import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, T0, type FakesFor, type FreshOptions } from '../../test/harness/ipc.ts'
import { SPEND, PURCHASE_CALLS } from '../../test/harness/entry-points.ts'
import { REQUEST, merge, worldFor, NODE_WG } from '../../test/harness/requests.ts'

// The connect path spends real funds (docs/invariants/reliability.md). These drive the
// REAL ipc-handlers.ts through its IPC handlers with the chain, the node and the
// tunnel faked, and check what it did with the money: what it bought, what it
// refunded, in what order, signed by whom, and what it told the user.

const ipc = await loadIpcHandlers()

const httpError = (status: number, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), { response: { status, data: { error: { message: `node says ${status}` } } } })

/** The handshake each purchase runs after paying, made to fail. */
function failingHandshake(key: (typeof SPEND)[number], err: () => Error): FreshOptions {
  return key === 'CONNECTION_SUBSCRIBE_CHAIN'
    ? { fakes: { 'chain/chain-service': { handshakeChainEntry: async () => { throw err() } } } }
    : { fakes: { 'chain/chain-service': { performHandshake: async () => { throw err() } } } }
}

const purchases = (h: ReturnType<typeof ipc.fresh>) =>
  PURCHASE_CALLS.flatMap((fn) => h.calls(fn === 'subscribeToNode' ? 'chain/chain-service' : 'plans/plan-service', fn))
const ended = (h: ReturnType<typeof ipc.fresh>) =>
  h.calls('chain/chain-service', 'endSession').map((c) => (c.args[0] as { sessionId: string }).sessionId)

describe('[REL-1] a purchase that fails after paying is refunded', () => {
  for (const key of SPEND) {
    test(`[REL-1] ${key}: control - a working handshake refunds nothing`, async (t) => {
      const h = ipc.fresh(worldFor(key))
      t.after(() => h.dispose())
      await h.settle(h.invoke(key, REQUEST[key]))
      assert.ok(purchases(h).length > 0, 'the fixture must reach a purchase')
      assert.deepEqual(ended(h), [])
    })

    test(`[REL-1] ${key}: a handshake failure after the purchase cancels that session`, async (t) => {
      const h = ipc.fresh(merge(worldFor(key), failingHandshake(key, () => httpError(500))))
      t.after(() => h.dispose())
      const err = await h.settleError(h.invoke(key, REQUEST[key]))
      assert.equal(purchases(h).length, 1, 'bought exactly once')
      assert.deepEqual(ended(h), ['1001'], 'the session just bought is the one cancelled')
      // A direct purchase says "deposit refunded"; a plan session spends an allocation, so "cancelled".
      assert.match(err.message, /refunded|was cancelled/i)
      assert.equal(h.tunnel.bringUps, 0, 'nothing was brought up')
      assert.deepEqual(h.sent('SESSIONS_CHANGED').length > 0, true, 'the Sessions tab is told to re-read')
    })
  }

  test('[REL-1] the cleartext-policy refusal is refunded and says why', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    const PolicyError = h.main.V2RayPolicyError as unknown as new (m: string) => Error
    h.world.fakes['chain/chain-service'].performHandshake = async () => { throw new PolicyError('node offers only VLess with no encryption') }
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    assert.deepEqual(ended(h), ['1001'])
    assert.match(err.message, /VLess|encrypt/i)
  })
})

describe('[REL-12] the handshake retries a 404 (node RPC lag), and only a 404', () => {
  test('[REL-12] 404, 404, then an answer: no refund, three tries, spaced out', async (t) => {
    const at: number[] = []
    let n = 0
    const h = ipc.fresh({ fakes: { 'chain/chain-service': {
      performHandshake: async () => {
        at.push(Date.now())
        if (n++ < 2) throw httpError(404)
        return { protocol: 'wireguard', configString: 'cfg-wireguard' } as never
      },
    } } })
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    assert.equal(at.length, 3)
    assert.deepEqual(ended(h), [])
    assert.ok(at[1] - at[0] >= 2000 && at[2] - at[1] >= 2000, `retries must wait for the node's RPC: ${at.map((x) => x - T0)}`)
  })

  test('[REL-12] a 404 that never clears is refunded after the retries', async (t) => {
    const h = ipc.fresh(failingHandshake('CONNECTION_SUBSCRIBE', () => httpError(404)))
    t.after(() => h.dispose())
    await h.settleError(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    assert.equal(h.calls('chain/chain-service', 'performHandshake').length, 3)
    assert.deepEqual(ended(h), ['1001'])
  })

  test('[REL-12] any other status is a verdict: refunded at once, no retry', async (t) => {
    const h = ipc.fresh(failingHandshake('CONNECTION_SUBSCRIBE', () => httpError(409)))
    t.after(() => h.dispose())
    await h.settleError(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    assert.equal(h.calls('chain/chain-service', 'performHandshake').length, 1)
    assert.deepEqual(ended(h), ['1001'])
  })
})

test('[REL-5] a refund that hangs is abandoned within its bound, and the message says it was NOT refunded', async (t) => {
  const h = ipc.fresh(merge(failingHandshake('CONNECTION_SUBSCRIBE', () => httpError(500)), {
    fakes: { 'chain/chain-service': { endSession: () => new Promise<never>(() => { /* never settles */ }) } },
  }))
  t.after(() => h.dispose())
  const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE), 5 * 60_000)
  assert.ok(Date.now() - T0 <= 60_000, `gave up after ${(Date.now() - T0) / 1000}s of virtual time`)
  assert.match(err.message, /#1001/, 'a stranded deposit is named so it can be cancelled by hand')
  assert.doesNotMatch(err.message, /deposit refunded/i)
})

describe('[MH-6] a failed chain refunds both hops, one at a time, each signed by its own wallet', () => {
  test('[MH-6] the exit handshake fails: entry and exit are both cancelled, in order, by their payers', async (t) => {
    let inFlight = 0
    let overlapped = false
    const h = ipc.fresh(merge(worldFor('CONNECTION_SUBSCRIBE_CHAIN'), { fakes: { 'chain/chain-service': {
      handshakeChainExit: async () => { throw httpError(500) },
      endSession: async () => {
        if (inFlight++ > 0) overlapped = true
        await new Promise((r) => setTimeout(r, 1000))
        inFlight--
      },
    } } }))
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    const cancels = h.calls('chain/chain-service', 'endSession').map((c) => c.args[0] as { sessionId: string; wallet: { fake: string } })
    assert.deepEqual(cancels.map((c) => c.sessionId), ['1001', '1002'])
    assert.deepEqual(cancels.map((c) => c.wallet.fake), ['wallet', 'exit-wallet'], 'x/session only accepts a cancel from the session\'s own account')
    assert.equal(overlapped, false, 'two cancels from one account collide on the sequence number')
    assert.match(err.message, /refund/i)
  })

  test('[MH-6] the entry handshake fails: only the entry was bought, only the entry is cancelled', async (t) => {
    const h = ipc.fresh(merge(worldFor('CONNECTION_SUBSCRIBE_CHAIN'), failingHandshake('CONNECTION_SUBSCRIBE_CHAIN', () => httpError(500))))
    t.after(() => h.dispose())
    await h.settleError(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    assert.equal(h.calls('chain/chain-service', 'subscribeToNode').length, 1)
    assert.deepEqual(ended(h), ['1001'])
  })
})

describe('[MH-19] smart connect spends the plan price at most once', () => {
  const twoNodes = (): FreshOptions => {
    const second = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw2'
    const row = (address: string, moniker: string) => ({ address, moniker, country: 'DE', type: 1, api: `https://${moniker}.example:8585`, isActive: true, isHealthy: true, version: '9.3.0' })
    let n = 0
    return {
      nodes: [row(NODE_WG, 'first'), row(second, 'second')],
      fakes: {
        'plans/plan-service': { listNodesForPlan: async () => [NODE_WG, second] },
        'nodes/node-tester': { probeNode: async () => ({ reachable: true, latencyMs: 40 }) as never },
        // The first node takes the money and then fails its handshake.
        'chain/chain-service': { performHandshake: async () => {
          if (n++ === 0) throw httpError(500)
          return { protocol: 'wireguard', configString: 'cfg-wireguard' } as never
        } },
      } satisfies FakesFor,
    }
  }

  test('[MH-19] after a refunded first try, the next node is a session on the SAME subscription', async (t) => {
    const h = ipc.fresh(twoNodes())
    t.after(() => h.dispose())
    await h.settle(h.invoke('PLAN_SMART_CONNECT', { planId: '42', denom: 'udvpn' }))
    assert.equal(h.calls('plans/plan-service', 'subscribeToPlan').length, 1, 'the plan price is paid once')
    assert.equal(h.calls('plans/plan-service', 'startSessionWithExistingSubscription').length, 1)
    assert.deepEqual(ended(h), ['1001'], 'the failed first session is refunded')
  })
})

describe('[REL-11] nothing is bought until the preflight passes', () => {
  type Refusal = { name: string; applies: (k: string) => boolean; fakes: FakesFor; nodes?: FreshOptions['nodes'] }
  const REFUSALS: Refusal[] = [
    { name: 'the machine is not set up', applies: () => true, fakes: { 'ipc/setup': { assertSystemReady: async () => { throw new Error('SYSTEM_SETUP_REQUIRED:helper:') } } } },
    { name: 'the protocol runtime is missing', applies: (k) => k !== 'PLAN_SMART_CONNECT', fakes: { 'vpn/vpn-manager': { protocolRuntimeError: () => 'wg-quick is not installed' } } },
    { name: 'the privileged service is out of date', applies: (k) => k !== 'CONNECTION_SUBSCRIBE_CHAIN', fakes: { 'helper/daemon-client': { daemonMissingOp: async () => true } } },
    { name: 'the node reports another protocol', applies: () => true, fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => 'openvpn' } } },
    { name: 'the node does not answer', applies: () => true, fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => { throw new Error('ETIMEDOUT') } } } },
  ]
  for (const key of SPEND) {
    for (const r of REFUSALS.filter((x) => x.applies(key))) {
      test(`[REL-11] ${key}: ${r.name} - nothing bought, and the message says so`, async (t) => {
        const h = ipc.fresh(merge(worldFor(key), { fakes: r.fakes }))
        t.after(() => h.dispose())
        const err = await h.settleError(h.invoke(key, REQUEST[key]))
        assert.deepEqual(purchases(h).map((c) => c.fn), [], 'no purchase may happen after a failed preflight')
        assert.match(err.message, /not charged|nothing was (charged|purchased)|SYSTEM_SETUP_REQUIRED/i)
      })
    }
  }

  test('[REL-11] [NT-4] a node the directory lists as signing, but which does not say so, is refused before paying', async (t) => {
    const h = ipc.fresh({
      nodes: [{ address: NODE_WG, moniker: 'node-wg', country: 'DE', type: 1, api: 'https://203.0.113.7:8585', isActive: true, isHealthy: true, version: '9.4.0' }],
      fakes: { 'nodes/node-tester': { fetchNodeSignsReplies: async () => false } },
    })
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    assert.deepEqual(purchases(h), [])
    assert.match(err.message, /not charged/)
  })
})

describe('[REL-12] the connect flow rides one RPC connection, owned by the handler that opened it', () => {
  /** openChainFlow, recording each flow it hands out and every close of it. */
  function flows(): { opened: Array<{ signing: object; closed: number }>; fakes: FreshOptions } {
    const opened: Array<{ signing: object; closed: number }> = []
    return {
      opened,
      fakes: { fakes: { 'chain/chain-clients': { openChainFlow: async () => {
        const f = { query: { flow: opened.length }, signing: { flow: opened.length }, closed: 0 }
        opened.push(f)
        return { query: f.query, signing: f.signing, disconnect: () => { f.closed++ } } as never
      } } } },
    }
  }
  const handed = (h: ReturnType<typeof ipc.fresh>) => purchases(h).map((c) => {
    const p = c.args[0] as { client?: object; clients?: { signing: object } }
    return p.clients?.signing ?? p.client
  })

  for (const key of SPEND) {
    for (const outcome of ['succeeds', 'fails after paying'] as const) {
      test(`[REL-12] ${key} ${outcome}: every flow it opens is closed exactly once, and the purchase rides it`, async (t) => {
        const { opened, fakes } = flows()
        const world = merge(worldFor(key), fakes)
        const h = ipc.fresh(outcome === 'succeeds' ? world : merge(world, failingHandshake(key, () => httpError(500))))
        t.after(() => h.dispose())
        await h.settle(h.invoke(key, REQUEST[key])).catch(() => undefined)
        assert.deepEqual(opened.map((f) => f.closed), opened.map(() => 1), 'closed once each, in the opener\'s finally')
        if (key === 'CONNECTION_SUBSCRIBE_CHAIN') {
          // A chain can pay its hops from two wallets, and a signing client is bound
          // to one: its purchases open their own (docs: "stay in standalone mode").
          assert.ok(handed(h).length > 0 && handed(h).every((c) => c === undefined))
        } else {
          assert.equal(opened.length, 1, 'one connection for the whole flow')
          assert.deepEqual(handed(h), [opened[0].signing], 'the purchase was handed the flow, not left to open its own')
        }
      })
    }
  }
})
