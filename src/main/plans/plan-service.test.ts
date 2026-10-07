import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from '../../../test/harness/module.ts'

// The two plan purchases ride the connect flow's signing client when handed one
// [REL-12], and bound how late their session-creating tx can land with a
// timeoutHeight [REL-5] (docs/invariants/reliability.md). The client is faked; the
// msg-building is the SDK's. Its reply carries no session event, so each purchase fails
// AFTER broadcasting: the path where a misplaced disconnect would close the caller's
// connection under it.

const ps = await loadModule({
  entries: ['src/main/plans/plan-service.ts'],
  fake: ['src/main/chain/chain-clients'],
  allowPackages: ['@cosmjs/stargate', '@cosmjs/proto-signing', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', '@cosmjs/tendermint-rpc', 'long', '@sentinel-official/sentinel-js-sdk'],
})

type Fn = (...a: unknown[]) => Promise<unknown>
const ADDRESS = 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu'
const NODE = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwg'

function flowClient() {
  const seen = { broadcasts: [] as unknown[][], closed: 0 }
  const client = {
    getHeight: async () => 31_895_796,
    signAndBroadcast: async (...args: unknown[]) => { seen.broadcasts.push(args); return { code: 0, events: [], height: 31_895_797, transactionHash: 'AB', gasUsed: 1n, gasWanted: 1n } },
    disconnect: () => { seen.closed++ },
  }
  return { client, seen }
}

const PURCHASES: Array<[string, Record<string, unknown>]> = [
  ['startSessionWithExistingSubscription', { subscriptionId: '77' }],
  ['subscribeToPlan', { planId: '42', denom: 'udvpn' }],
]

for (const [fn, args] of PURCHASES) {
  test(`[REL-5] [REL-12] ${fn} bounds its tx with a timeoutHeight and never closes the client it was handed`, async (t) => {
    const h = ps.fresh({})
    t.after(() => h.dispose())
    const { client, seen } = flowClient()
    await assert.rejects((h.mod[fn] as Fn)({ wallet: {}, address: ADDRESS, nodeAddress: NODE, client, ...args }), /session creation event/)
    assert.equal(seen.broadcasts.length, 1)
    assert.equal(seen.broadcasts[0][4], BigInt(31_895_796 + 30))
    assert.equal(seen.closed, 0, 'the caller owns the flow')
    assert.deepEqual(h.world.calls('chain/chain-clients'), [], 'and no second connection was opened beside it')
  })
}
