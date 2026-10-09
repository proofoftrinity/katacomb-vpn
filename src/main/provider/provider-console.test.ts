import { test, describe, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, type ModuleHarness } from '../../../test/harness/module.ts'
import type { Fakes } from '../../../test/harness/world.ts'
import { PROVIDER_WRITE_CALLS } from '../../../test/harness/entry-points.ts'
import { TX_TIMEOUT_HEIGHT_OFFSET } from '../chain/chain-constants.ts'

// The provider ops each sign and broadcast one provider tx [PC-13]. The signing client
// is the SDK's, answered by the test (test/harness/sentinel-sdk.ts); the messages, the
// registry, the write lock and the tx checks are real.

const pc = await loadModule({
  entries: ['src/main/provider/provider-console.ts', 'src/main/provider/provider-msgs.ts'],
  fake: ['src/main/chain/chain-clients', 'src/main/chain/lease-query', 'src/main/chain/protobuf-query'],
  allowPackages: ['@cosmjs/stargate', '@cosmjs/proto-signing', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', 'long', '@sentinel-official/sentinel-js-sdk'],
  stubs: { '@sentinel-official/sentinel-js-sdk': 'test/harness/sentinel-sdk.ts' },
})

const ADDR = 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5ye68zn'
const NODE = 'sentnode1qqrsu9guyv4rzwplgex4gkmzd9c8wl59lfxrgj'
const HEIGHT = 31_895_796
const DETAILS = { name: 'Acme', identity: '', website: '', description: '' }

type Op = (typeof PROVIDER_WRITE_CALLS)[number]
/** What each op is called with, besides the wallet and the account. */
const PARAMS: Record<Op, Record<string, unknown>> = {
  registerProvider: { details: DETAILS },
  updateProviderDetails: { details: DETAILS },
  setProviderStatus: { active: false },
  createPlan: { input: { gigabytes: 10, days: 30, priceUdvpn: 1_000_000, private: false } },
  setPlanStatus: { planId: '7', active: true },
  updatePlanDetails: { planId: '7', private: true },
  linkNode: { planId: '7', nodeAddress: NODE },
  unlinkNode: { planId: '7', nodeAddress: NODE },
  startLease: { nodeAddress: NODE, hours: 24, hourlyQuoteValue: '1000', renewalPricePolicy: 7 },
  renewLease: { leaseId: '42', hours: 48, hourlyQuoteValue: '1000' },
  updateLease: { leaseId: '42', renewalPricePolicy: 7 },
  endLease: { leaseId: '42' },
}

interface Chain {
  connects: unknown[][]
  broadcasts: unknown[][]
  disconnects: number
}

/** A chain whose signing client answers every broadcast with `code`, after `gate` opens. */
function chain(t: TestContext, opts: { code?: number; throws?: Error; gate?: Promise<void> } = {}): { c: Chain; h: ModuleHarness } {
  const c: Chain = { connects: [], broadcasts: [], disconnects: 0 }
  const client = {
    getHeight: async () => HEIGHT,
    signAndBroadcast: async (...args: unknown[]) => {
      c.broadcasts.push(args)
      await opts.gate
      if (opts.throws) throw opts.throws
      const code = opts.code ?? 0
      return { code, rawLog: code ? 'unauthorized: lease 42 does not belong to this provider' : '', events: [], height: HEIGHT + 1, transactionHash: 'AB', gasUsed: 1n, gasWanted: 1n }
    },
    disconnect: () => { c.disconnects++ },
  }
  const fakes: Fakes = {
    'chain/chain-clients': { resolveRpcBase: async (u: string) => u },
    sdk: { connectWithSigner: async (...args: unknown[]) => { c.connects.push(args); return client } },
  }
  const h = pc.fresh(fakes)
  t.after(() => h.dispose())
  return { c, h }
}

const call = (h: ModuleHarness, op: Op) =>
  (h.mod[op] as unknown as (p: unknown) => Promise<void>)({ wallet: {}, accountAddress: ADDR, ...PARAMS[op] })

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(cond(), 'the condition never held')
}

describe('[PC-13] every provider tx is signed with the lease-aware registry, bounded, checked and closed', () => {
  for (const op of PROVIDER_WRITE_CALLS) {
    test(`[PC-13] [PC-4] ${op}: signed through CHAIN_REGISTRY, which encodes its msg, with a timeoutHeight`, async (t) => {
      const { c, h } = chain(t)
      await call(h, op)
      assert.equal(c.connects.length, 1)
      const registry = (c.connects[0][2] as { registry: { lookupType(url: string): unknown } }).registry
      assert.equal(registry, h.mod.CHAIN_REGISTRY, 'the registry that names the lease and plan-details types, not the SDK default')
      assert.equal(c.broadcasts.length, 1)
      const [signer, msgs, , , timeoutHeight] = c.broadcasts[0] as [string, Array<{ typeUrl: string }>, unknown, unknown, bigint]
      assert.equal(signer, ADDR)
      assert.equal(msgs.length, 1)
      assert.ok(registry.lookupType(msgs[0].typeUrl), `${msgs[0].typeUrl} must be registered, or encoding throws`)
      assert.equal(timeoutHeight, BigInt(HEIGHT + TX_TIMEOUT_HEIGHT_OFFSET), 'past this height the chain rejects it, so a timeout stays a timeout')
      assert.equal(c.disconnects, 1)
    })
  }

  test('[PC-13] a tx the chain rejects throws, and the client is still closed', async (t) => {
    const { c, h } = chain(t, { code: 4 })
    await assert.rejects(call(h, 'endLease'), /failed with code 4/)
    assert.equal(c.disconnects, 1)
  })

  test('[PC-13] a broadcast that throws still closes the client', async (t) => {
    const { c, h } = chain(t, { throws: new Error('socket hang up') })
    await assert.rejects(call(h, 'startLease'), /socket hang up/)
    assert.equal(c.disconnects, 1)
  })

  test('[PC-13] two writes in flight are signed one after the other, not on the same sequence', async (t) => {
    let open = () => {}
    const gate = new Promise<void>((r) => { open = r })
    const { c, h } = chain(t, { gate })
    const first = call(h, 'linkNode')
    const second = call(h, 'unlinkNode')
    await until(() => c.broadcasts.length === 1)
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    assert.equal(c.connects.length, 1, 'the second write waits for the first to finish before it even connects')
    open()
    await Promise.all([first, second])
    assert.equal(c.connects.length, 2)
    assert.equal(c.broadcasts.length, 2)
  })

  test('[PC-13] a failed write does not block the next one', async (t) => {
    const { c, h } = chain(t, { code: 4 })
    const first = call(h, 'endLease').then(() => null, (e: Error) => e)
    const second = call(h, 'linkNode').then(() => null, (e: Error) => e)
    assert.ok(await first)
    assert.ok(await second, 'the second also ran (and was refused by this chain), rather than hanging')
    assert.equal(c.broadcasts.length, 2)
  })
})
