import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadModule } from '../../../test/harness/module.ts'

// [REL-23] A session row is not necessarily live. The chain's status enum is 1 active,
// 2 inactive_pending (what a session becomes on its own when its quota runs out), 3
// inactive; decodeSession maps all three rather than `=== 1 ? 'active' : 'inactive'`,
// and the list keeps the settling rows so they can be labelled instead of vanishing.
// Rows are real protobuf, encoded with the SDK the chain's replies are decoded with.

const wallet = await loadModule({
  entries: ['src/main/chain/wallet.ts'],
  fake: ['src/main/chain/chain-clients'],
  allowPackages: ['@cosmjs/proto-signing', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', '@cosmjs/stargate', '@cosmjs/tendermint-rpc', 'long', '@sentinel-official/sentinel-js-sdk', '@scure/bip39'],
})

const require = createRequire(import.meta.url)
const { Session: NodeSession } = require('@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/node/v3/session') as {
  Session: { encode: (m: unknown) => { finish: () => Uint8Array }; fromPartial: (m: unknown) => unknown }
}

const row = (id: number, status: number) => ({
  typeUrl: '/sentinel.node.v3.Session',
  value: NodeSession.encode(NodeSession.fromPartial({
    baseSession: { id, status, nodeAddress: 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwg', downloadBytes: '0', uploadBytes: '0', maxBytes: '0' },
    price: { denom: 'udvpn', quoteValue: '5000000' },
  })).finish(),
})

test('[REL-23] the real status enum: 1 active, 2 inactive_pending kept and labelled, 3 settled and dropped', async (t) => {
  const h = wallet.fresh({})
  t.after(() => h.dispose())
  let closed = 0
  const client = {
    sentinelQuery: { session: { sessionsForAccount: async () => ({ sessions: [row(66488552, 1), row(66451960, 2), row(64725039, 3)] }) } },
    disconnect: () => { closed++ },
  }
  const got = await (h.mod.getSessionsForAddress as (a: string, c: unknown) => Promise<Array<{ id: string; status: string }>>)('sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', client)
  assert.deepEqual(got.map((s) => [s.id, s.status]), [['66488552', 'active'], ['66451960', 'inactive_pending']])
  assert.equal(closed, 0, '[REL-12] a client handed in stays its caller\'s to close')
})
