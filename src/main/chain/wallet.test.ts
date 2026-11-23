import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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

// [REL-50] No two stored wallets share a name. The store decides (settings.ts); these
// are the two ways a wallet is made, an import and a derived account, reaching it.
test('[REL-50] an import or a derived account under a name in use is refused and stores nothing; unnamed ones get free names', async (t) => {
  const h = wallet.fresh({})
  t.after(() => h.dispose())
  const SEED = `${'abandon '.repeat(11)}about`
  const OTHER = `${'legal winner thank year wave sausage worth useful legal winner thank '}yellow`
  const importWallet = h.mod.importWallet as (m: string, name?: string) => Promise<string>
  const derive = h.mod.deriveSubaccount as (source: string, account: number, index: number, name: string) => Promise<string>
  const stored = () => JSON.parse(readFileSync(join(h.world.userData, 'wallets-index.json'), 'utf-8')) as Array<{ id: string; name: string }>

  await importWallet(SEED, 'Main')
  await assert.rejects(importWallet(OTHER, 'main'), /A wallet named "main" already exists/)
  await assert.rejects(derive(stored()[0].id, 0, 1, 'MAIN'), /A wallet named "MAIN" already exists/)
  assert.deepEqual(stored().map((w) => w.name), ['Main'])

  // Control: the same two, unnamed, are stored under names the store picks.
  await importWallet(OTHER)
  await derive(stored()[0].id, 0, 1, '')
  assert.deepEqual(stored().map((w) => w.name), ['Main', 'Wallet 2', 'Wallet 3'])
})
