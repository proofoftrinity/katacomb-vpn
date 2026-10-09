import { test, describe, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, type ModuleHarness } from '../../../test/harness/module.ts'
import type { Fakes } from '../../../test/harness/world.ts'
import { PROVIDER_WRITE_CALLS, PROVIDER_WRITES } from '../../../test/harness/entry-points.ts'
import { IPC } from '../../shared/ipc-channels.ts'
import { FEE_RESERVE_UDVPN } from '../../shared/funds.ts'
import { INSUFFICIENT_FUNDS } from '../../shared/error-markers.ts'

// The provider console's handlers (docs/provider-console.md). Each write is one provider
// tx, and the rules here decide whether it is broadcast at all and at what price: funds
// priced from the chain [PC-7], no lease on a node that cannot hold one [PC-8], only a
// lease this wallet owns [PC-9], nothing while the tunnel is up [PC-10]. The ops that
// sign (provider-console), the chain reads and the wallet are faked; the funds check,
// the validators, the renewal policy, the lease pricing and the caches are real.

const pv = await loadModule({
  entries: ['src/main/ipc/provider.ts'],
  fake: [
    'src/main/provider/provider-console', 'src/main/provider/provider-service', 'src/main/chain/lease-query',
    'src/main/chain/chain-clients', 'src/main/chain/price-service', 'src/main/chain/rpc-monitor',
    'src/main/chain/wallet', 'src/main/plans/plan-service', 'src/main/vpn/vpn-manager',
  ],
  allowPackages: ['@cosmjs/proto-signing', '@cosmjs/encoding', '@cosmjs/stargate', '@cosmjs/crypto', '@cosmjs/amino', 'long', '@sentinel-official/sentinel-js-sdk'],
})

const ADDR = 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5ye68zn'
const PROV = 'sentprov1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5vwxuet' // ADDR's provider address
const OTHER = 'sent19qnjvffyyv3zzgqlrcw3cxc6ryvpw9s4u9mkh2'
const NODE = 'sentnode1qqrsu9guyv4rzwplgex4gkmzd9c8wl59lfxrgj'
const HOURLY = '1000'
const LEASE = { id: '42', provAddress: PROV, nodeAddress: NODE, hourlyPrice: HOURLY, hours: 10, maxHours: 24, renewalPricePolicy: 7, startAt: null }
const DETAILS = { name: 'Acme', identity: '', website: '', description: '' }

type Write = (typeof PROVIDER_WRITES)[number]
/** One valid request per provider write, and the provider-console op it must end in. */
const WRITES: Record<Write, { req: unknown; op: (typeof PROVIDER_WRITE_CALLS)[number] }> = {
  PROVIDER_REGISTER: { req: DETAILS, op: 'registerProvider' },
  PROVIDER_UPDATE_DETAILS: { req: DETAILS, op: 'updateProviderDetails' },
  PROVIDER_SET_STATUS: { req: { active: true }, op: 'setProviderStatus' },
  PROVIDER_PLAN_CREATE: { req: { gigabytes: 10, days: 30, priceUdvpn: 1_000_000, private: false }, op: 'createPlan' },
  PROVIDER_PLAN_SET_STATUS: { req: { planId: '7', active: true }, op: 'setPlanStatus' },
  PROVIDER_PLAN_SET_PRIVATE: { req: { planId: '7', private: true }, op: 'updatePlanDetails' },
  PROVIDER_PLAN_LINK: { req: { planId: '7', nodeAddress: NODE }, op: 'linkNode' },
  PROVIDER_PLAN_UNLINK: { req: { planId: '7', nodeAddress: NODE }, op: 'unlinkNode' },
  LEASE_START: { req: { nodeAddress: NODE, hours: 24, renewalPolicy: 7 }, op: 'startLease' },
  LEASE_RENEW: { req: { leaseId: '42', hours: 48 }, op: 'renewLease' },
  LEASE_UPDATE_POLICY: { req: { leaseId: '42', renewalPolicy: 7 }, op: 'updateLease' },
  LEASE_END: { req: { leaseId: '42' }, op: 'endLease' },
}

/** What the faked world is doing; the fakes read it at call time, so a test can change it midway. */
interface State { vpn: boolean; address: string; balance: number }

interface Console {
  h: ModuleHarness
  s: State
  invoke: (key: keyof typeof IPC, req?: unknown) => Promise<unknown>
  /** The error a call fails with, or null when it succeeds. */
  error: (key: keyof typeof IPC, req?: unknown) => Promise<Error | null>
  /** Calls made to a provider-console op. */
  ops: (op: string) => ReturnType<ModuleHarness['world']['calls']>
}

function open(t: TestContext, state: Partial<State> = {}, fakes: Fakes = {}): Console {
  const s: State = { vpn: false, address: ADDR, balance: 10_000_000_000, ...state }
  const ok = async () => undefined
  const base: Fakes = {
    'chain/wallet': {
      getWallet: () => ({}),
      getAddress: () => s.address,
      getBalance: async () => [{ denom: 'udvpn', amount: String(s.balance) }],
    },
    'vpn/vpn-manager': { isVpnActive: () => s.vpn },
    'chain/rpc-monitor': { reportRpcFailure: () => undefined, getRpcHealth: () => ({ endpoint: 'https://rpc.example' }) },
    'provider/provider-console': {
      ...Object.fromEntries(Object.values(WRITES).map((w) => [w.op, ok])),
      getProviderDeposit: async () => ({ denom: 'udvpn', amount: '0' }),
      getNodeHourlyPrice: async (address: string) => ({ address, hourlyPrice: HOURLY, status: 1 }),
    },
    'chain/lease-query': {
      getLeaseParams: async () => ({ minHours: 1, maxHours: 720, stakingShare: '' }),
      listLeasesForProvider: async () => [LEASE],
    },
    'plans/plan-service': { invalidatePlanNodes: () => undefined, invalidateAllPlanNodes: () => undefined },
  }
  for (const [mod, fns] of Object.entries(fakes)) base[mod] = { ...base[mod], ...fns }
  const h = pv.fresh(base)
  t.after(() => h.dispose())

  type Listener = (event: unknown, ...args: unknown[]) => unknown
  const handlers = new Map<string, Listener>()
  ;(h.mod.registerProviderHandlers as (handle: (channel: string, fn: Listener) => void) => void)(
    (channel, fn) => { handlers.set(channel, fn) },
  )
  const invoke = async (key: keyof typeof IPC, req?: unknown) => {
    const fn = handlers.get(IPC[key])
    if (!fn) throw new Error(`no handler registered for ${key}`)
    return fn({}, req)
  }
  return {
    h,
    s,
    invoke,
    error: (key, req) => invoke(key, req).then(() => null, (e: Error) => e),
    ops: (op) => h.world.calls('provider/provider-console', op),
  }
}

test('the request table covers every provider write, each ending in its own op', () => {
  assert.deepEqual(Object.values(WRITES).map((w) => w.op).sort(), [...PROVIDER_WRITE_CALLS].sort())
})

describe('[PC-10] every provider write refuses while the tunnel is up', () => {
  for (const key of PROVIDER_WRITES) {
    test(`[PC-10] ${key} is refused before any chain read, funds check or broadcast`, async (t) => {
      const c = open(t, { vpn: true })
      assert.match((await c.error(key, WRITES[key].req))?.message ?? '', /Disconnect first/)
      const reached = c.h.world.log.filter((l) => l.mod !== 'vpn/vpn-manager' && !(l.mod === 'chain/wallet' && l.fn !== 'getBalance'))
      assert.deepEqual(reached, [])
    })
  }
})

describe('[PC-7] every provider write checks funds before it broadcasts', () => {
  for (const key of PROVIDER_WRITES) {
    test(`[PC-7] ${key} from an empty wallet is refused, nothing broadcast`, async (t) => {
      const c = open(t, { balance: 0 })
      assert.match((await c.error(key, WRITES[key].req))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
      assert.equal(c.ops(WRITES[key].op).length, 0)
    })

    test(`[PC-7] [PC-10] control: ${key} with funds and no tunnel broadcasts once, after reading the balance`, async (t) => {
      const c = open(t)
      await c.invoke(key, WRITES[key].req)
      const sent = c.ops(WRITES[key].op)
      assert.equal(sent.length, 1)
      const checked = c.h.world.calls('chain/wallet', 'getBalance')
      assert.equal(checked.length, 1)
      assert.ok(checked[0].seq < sent[0].seq, 'the balance is read before the broadcast')
      assert.equal((sent[0].args[0] as { accountAddress: string }).accountAddress, ADDR)
    })
  }
})

describe('[PC-7] the funds check is priced in main from on-chain values', () => {
  test('[PC-7] a lease start costs the node\'s on-chain hourly price × the hours asked, plus the fee reserve', async (t) => {
    const need = 1000 * 24 + FEE_RESERVE_UDVPN
    assert.match((await open(t, { balance: need - 1 }).error('LEASE_START', WRITES.LEASE_START.req))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
    const c = open(t, { balance: need })
    await c.invoke('LEASE_START', WRITES.LEASE_START.req)
    const [sent] = c.ops('startLease')
    assert.deepEqual(
      [(sent.args[0] as { hourlyQuoteValue: string }).hourlyQuoteValue, (sent.args[0] as { hours: number }).hours],
      [HOURLY, 24],
      'the MaxPrice sent is the chain\'s hourly price',
    )
    assert.equal(c.h.world.calls('provider/provider-console', 'getNodeHourlyPrice')[0].args[0], NODE)
  })

  test('[PC-7] a figure the renderer adds is ignored: the check and the MaxPrice use the chain\'s price', async (t) => {
    const req = { nodeAddress: NODE, hours: 24, renewalPolicy: 7, hourlyQuoteValue: '1', totalUdvpn: 1 }
    assert.match((await open(t, { balance: 1000 * 24 + FEE_RESERVE_UDVPN - 1 }).error('LEASE_START', req))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
    const c = open(t)
    await c.invoke('LEASE_START', req)
    assert.equal((c.ops('startLease')[0].args[0] as { hourlyQuoteValue: string }).hourlyQuoteValue, HOURLY)
  })

  test('[PC-7] a renew is priced on the whole new term at today\'s price, not on the hours left', async (t) => {
    // The lease has used 10 of its 24 hours; renewing for 48 charges 48 fresh hours.
    const need = 1000 * 48 + FEE_RESERVE_UDVPN
    assert.match((await open(t, { balance: need - 1 }).error('LEASE_RENEW', WRITES.LEASE_RENEW.req))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
    const c = open(t, { balance: need })
    await c.invoke('LEASE_RENEW', WRITES.LEASE_RENEW.req)
    assert.equal((c.ops('renewLease')[0].args[0] as { hourlyQuoteValue: string }).hourlyQuoteValue, HOURLY)
    assert.equal(c.h.world.calls('provider/provider-console', 'getNodeHourlyPrice')[0].args[0], NODE, 'priced on the lease\'s own node')
  })

  test('[PC-7] registration is priced on the live deposit', async (t) => {
    const deposit = { 'provider/provider-console': { getProviderDeposit: async () => ({ denom: 'udvpn', amount: '5000000' }) } }
    const need = 5_000_000 + FEE_RESERVE_UDVPN
    const short = open(t, { balance: need - 1 }, deposit)
    assert.match((await short.error('PROVIDER_REGISTER', DETAILS))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
    assert.equal(short.ops('registerProvider').length, 0)
    const c = open(t, { balance: need }, deposit)
    await c.invoke('PROVIDER_REGISTER', DETAILS)
    assert.equal(c.ops('registerProvider').length, 1)
  })

  test('[PC-7] a deposit that cannot be priced refuses the registration', async (t) => {
    for (const [deposit, why] of [[{ denom: 'uatom', amount: '5' }, /cannot verify funds/], [{ denom: 'udvpn', amount: 'abc' }, /could not be read/]] as const) {
      const c = open(t, {}, { 'provider/provider-console': { getProviderDeposit: async () => deposit } })
      assert.match((await c.error('PROVIDER_REGISTER', DETAILS))?.message ?? '', why)
      assert.equal(c.ops('registerProvider').length, 0)
    }
  })

  test('[PC-7] a gas-only write needs only the fee reserve: a plan\'s price is what subscribers pay', async (t) => {
    const short = open(t, { balance: FEE_RESERVE_UDVPN - 1 })
    assert.match((await short.error('PROVIDER_PLAN_CREATE', WRITES.PROVIDER_PLAN_CREATE.req))?.message ?? '', new RegExp(INSUFFICIENT_FUNDS))
    const c = open(t, { balance: FEE_RESERVE_UDVPN })
    await c.invoke('PROVIDER_PLAN_CREATE', WRITES.PROVIDER_PLAN_CREATE.req)
    assert.equal(c.ops('createPlan').length, 1)
  })
})

describe('[PC-8] a lease is never started on a node that cannot hold one', () => {
  for (const status of [0, 2, 3]) {
    test(`[PC-8] a node with chain status ${status} is refused before the funds check, nothing escrowed`, async (t) => {
      const c = open(t, {}, { 'provider/provider-console': { getNodeHourlyPrice: async (address: string) => ({ address, hourlyPrice: HOURLY, status }) } })
      assert.match((await c.error('LEASE_START', WRITES.LEASE_START.req))?.message ?? '', /not active on chain/)
      assert.equal(c.ops('startLease').length, 0)
      assert.equal(c.h.world.calls('chain/wallet', 'getBalance').length, 0)
      assert.equal(c.h.world.calls('provider/provider-console', 'getNodeHourlyPrice')[0].args[0], NODE, 'read fresh, for the node asked for')
    })
  }

  test('[PC-8] a node that publishes no P2P hourly price is refused', async (t) => {
    const c = open(t, {}, { 'provider/provider-console': { getNodeHourlyPrice: async (address: string) => ({ address, hourlyPrice: '', status: 1 }) } })
    assert.match((await c.error('LEASE_START', WRITES.LEASE_START.req))?.message ?? '', /does not publish an hourly price/)
    assert.equal(c.ops('startLease').length, 0)
  })
})

describe('[PC-9] lease ops act only on a lease the chain lists for this provider', () => {
  for (const key of ['LEASE_RENEW', 'LEASE_UPDATE_POLICY', 'LEASE_END'] as const) {
    test(`[PC-9] ${key} on a lease id the chain does not list is refused, nothing broadcast`, async (t) => {
      const c = open(t)
      const req = { ...(WRITES[key].req as object), leaseId: '99' }
      assert.match((await c.error(key, req))?.message ?? '', /no longer on chain/)
      assert.equal(c.ops(WRITES[key].op).length, 0)
      assert.equal(c.h.world.calls('chain/wallet', 'getBalance').length, 0)
      assert.deepEqual(c.h.world.calls('chain/lease-query', 'listLeasesForProvider').map((l) => l.args[0]), [PROV], 'this wallet\'s provider list')
    })
  }
})

describe('[PC-3] the renewal price policy gates a manual renew in main', () => {
  const leasing = (lease: Partial<typeof LEASE>, currentPrice = HOURLY): Fakes => ({
    'chain/lease-query': { listLeasesForProvider: async () => [{ ...LEASE, ...lease }] },
    'provider/provider-console': { getNodeHourlyPrice: async (address: string) => ({ address, hourlyPrice: currentPrice, status: 1 }) },
  })

  test('[PC-3] a lease bought as "never renew" is refused before the funds check, nothing broadcast', async (t) => {
    const c = open(t, {}, leasing({ renewalPricePolicy: 0 }))
    assert.match((await c.error('LEASE_RENEW', WRITES.LEASE_RENEW.req))?.message ?? '', /never renew/)
    assert.equal(c.ops('renewLease').length, 0)
    assert.equal(c.h.world.calls('chain/wallet', 'getBalance').length, 0)
  })

  test('[PC-3] "renew if lesser" compares the node\'s price now with the price stored on the lease', async (t) => {
    const up = open(t, {}, leasing({ renewalPricePolicy: 1, hourlyPrice: '900' }, '1000'))
    assert.match((await up.error('LEASE_RENEW', WRITES.LEASE_RENEW.req))?.message ?? '', /does not allow/)
    assert.equal(up.ops('renewLease').length, 0)
    const down = open(t, {}, leasing({ renewalPricePolicy: 1, hourlyPrice: '900' }, '800'))
    await down.invoke('LEASE_RENEW', WRITES.LEASE_RENEW.req)
    assert.equal(down.ops('renewLease').length, 1)
  })
})

describe('[PC-10] the overview never serves another wallet\'s answer or a guess', () => {
  const OVERVIEW = { provider: { registered: true, address: PROV }, plans: [], leases: [], economics: null }
  const reading = (impl: () => Promise<unknown> = async () => OVERVIEW): Fakes => ({ 'provider/provider-console': { getProviderOverview: impl } })

  test('[PC-10] with the tunnel up it serves the last answer read for this address, marked stale, without a chain read', async (t) => {
    const c = open(t, {}, reading())
    const live = await c.invoke('PROVIDER_OVERVIEW') as { fetchedAt: number; stale: boolean }
    assert.equal(live.stale, false)
    c.s.vpn = true
    assert.deepEqual(await c.invoke('PROVIDER_OVERVIEW'), { ...OVERVIEW, fetchedAt: live.fetchedAt, stale: true })
    assert.equal(c.ops('getProviderOverview').length, 1)
  })

  test('[PC-10] after a wallet switch the cached answer is not served: null, never the other wallet\'s', async (t) => {
    const c = open(t, {}, reading())
    await c.invoke('PROVIDER_OVERVIEW')
    c.s.address = OTHER
    c.s.vpn = true
    assert.equal(await c.invoke('PROVIDER_OVERVIEW'), null)
  })

  test('[PC-10] with the tunnel up and nothing cached, the overview and the deposit are unknown (null)', async (t) => {
    const c = open(t, { vpn: true }, reading())
    assert.equal(await c.invoke('PROVIDER_OVERVIEW'), null)
    assert.equal(await c.invoke('PROVIDER_DEPOSIT'), null)
    assert.equal(c.h.world.calls('provider/provider-console').length, 0)
  })

  test('[PC-10] a failed live read throws when nothing is cached, and serves the cache, stale, when something is', async (t) => {
    let fail = true
    const c = open(t, {}, reading(async () => { if (fail) throw new Error('decode: unexpected wire type 7'); return OVERVIEW }))
    assert.match((await c.error('PROVIDER_OVERVIEW'))?.message ?? '', /unexpected wire type/, 'never read as "no provider"')
    fail = false
    const live = await c.invoke('PROVIDER_OVERVIEW') as { fetchedAt: number }
    fail = true
    assert.deepEqual(await c.invoke('PROVIDER_OVERVIEW'), { ...OVERVIEW, fetchedAt: live.fetchedAt, stale: true })
  })
})

describe('[PC-11] the plan-node caches are invalidated after a link change, even when the tx fails', () => {
  const cases = [
    { key: 'PROVIDER_PLAN_LINK', invalidates: 'invalidatePlanNodes', args: ['7'] },
    { key: 'PROVIDER_PLAN_UNLINK', invalidates: 'invalidatePlanNodes', args: ['7'] },
    { key: 'LEASE_END', invalidates: 'invalidateAllPlanNodes', args: [] },
    { key: 'PROVIDER_SET_STATUS', invalidates: 'invalidateAllPlanNodes', args: [], req: { active: false } },
  ] as const
  for (const c of cases) {
    for (const fails of [false, true]) {
      test(`[PC-11] ${c.key}${'req' in c ? ' (deactivate)' : ''} ${fails ? 'that times out' : 'that lands'} invalidates ${c.invalidates}`, async (t) => {
        const op = WRITES[c.key].op
        const timedOut = async () => { throw new Error('The transaction timed out before confirmation. It may still be processing.') }
        const con = open(t, {}, fails ? { 'provider/provider-console': { [op]: timedOut } } : {})
        const err = await con.error(c.key, 'req' in c ? c.req : WRITES[c.key].req)
        assert.equal(err === null, !fails)
        const done = con.h.world.calls('plans/plan-service', c.invalidates)
        assert.equal(done.length, 1)
        assert.deepEqual(done[0].args, c.args)
        assert.ok(done[0].seq > con.ops(op)[0].seq, 'after the tx, so the re-read sees it')
      })
    }
  }

  test('[PC-11] activating the provider unlinks nothing, so it keeps the caches', async (t) => {
    const c = open(t)
    await c.invoke('PROVIDER_SET_STATUS', { active: true })
    assert.equal(c.h.world.calls('plans/plan-service').length, 0)
  })
})

describe('[PC-12] plan stats report null for a plan that could not be read', () => {
  const STATS = { subscriptions: 5, active: 3, truncated: false }

  test('[PC-12] one unreadable plan is null, the others are counted, and the connection is closed', async (t) => {
    const closed: number[] = []
    const c = open(t, {}, {
      'chain/chain-clients': { openChainQuery: async () => ({ query: {}, disconnect: () => { closed.push(1) } }) },
      'plans/plan-service': { listNodesForPlan: async () => [{}, {}] },
      'provider/provider-console': {
        getPlanSubscriberStats: async (planId: string) => {
          if (planId === '2') throw new Error('decode: unexpected wire type 7')
          return STATS
        },
      },
    })
    const stats = await c.invoke('PROVIDER_PLAN_STATS', { planIds: ['1', '2', '3'] }) as Record<string, unknown>
    assert.deepEqual(stats, { 1: { nodes: 2, ...STATS }, 2: null, 3: { nodes: 2, ...STATS } })
    assert.deepEqual(Object.keys(stats).sort(), ['1', '2', '3'], 'the unreadable plan is present, as null')
    assert.equal(closed.length, 1)
  })

  test('[PC-12] with the tunnel up, or no query connection, every plan is null', async (t) => {
    const all = { 1: null, 2: null }
    assert.deepEqual(await open(t, { vpn: true }).invoke('PROVIDER_PLAN_STATS', { planIds: ['1', '2'] }), all)
    const offline = open(t, {}, { 'chain/chain-clients': { openChainQuery: async () => { throw new Error('fetch failed') } } })
    assert.deepEqual(await offline.invoke('PROVIDER_PLAN_STATS', { planIds: ['1', '2'] }), all)
  })
})
