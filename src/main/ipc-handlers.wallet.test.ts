import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadIpcHandlers, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { WALLET_MUTATORS, ACTIVE_WALLET_CALLS } from '../../test/harness/entry-points.ts'
import { REQUEST, NODE_WG } from '../../test/harness/requests.ts'

// [REL-4] The active wallet is frozen while a session is live. A single-hop session's
// saved config carries no walletId, so its owner is "whichever wallet is active": a
// switch mid-session makes the cancel and the reconnect handshake sign with the wrong
// key, x/session rejects the cancel, and the deposit is stranded until expiry.

const ipc = await loadIpcHandlers()

const INDEX = [
  { id: 'w1', name: 'Main', address: 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu' },
  { id: 'w2', name: 'Second', address: 'sent1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqexit' },
]
const world = (extra: FreshOptions = {}): FreshOptions => ({
  walletsIndex: INDEX,
  settings: { activeWalletId: 'w1', ...(extra.settings ?? {}) },
  ...extra,
  fakes: {
    'chain/chain-service': { loadSessionConfig: () => ({ sessionId: '1001', nodeAddress: NODE_WG, protocol: 'wireguard', configString: 'cfg' }) as never },
    ...(extra.fakes ?? {}),
  },
})

const ARGS: Record<(typeof WALLET_MUTATORS)[number], unknown[]> = {
  WALLET_IMPORT: ['abandon '.repeat(11) + 'about', 'Third'],
  WALLET_SWITCH: ['w2'],
  WALLET_DELETE: ['w2'],
  WALLET_DELETE_ALL: [],
  WALLET_DELETE_SEED: ['w1'],
}

async function connect(h: IpcHarness): Promise<void> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
  await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' }))
}

const walletCalls = (h: IpcHarness) => h.calls('chain/wallet').filter((c) => ACTIVE_WALLET_CALLS.includes(c.fn))
const index = (h: IpcHarness) => readFileSync(join(h.world.userData, 'wallets-index.json'), 'utf-8')
const settings = (h: IpcHarness) => JSON.parse(readFileSync(join(h.world.userData, 'settings.json'), 'utf-8')) as Record<string, unknown>

describe('[REL-4] the active wallet is frozen while a session is live', () => {
  for (const key of WALLET_MUTATORS) {
    test(`[REL-4] ${key} is refused while connected, touches nothing, and works once disconnected`, async (t) => {
      const h = ipc.fresh(world())
      t.after(() => h.dispose())
      await connect(h)
      const before = index(h)
      const err = await h.settleError(h.invoke(key, ...ARGS[key]))
      assert.match(err.message, /Already connected/)
      assert.deepEqual(walletCalls(h), [], 'no wallet change reached wallet.ts')
      assert.equal(index(h), before, 'wallets-index.json is byte-identical')
      // Positive control.
      await h.settle(h.main.performDisconnect() as Promise<void>)
      const outcome = await h.settle(h.invoke(key, ...ARGS[key])).then(() => null, (e: Error) => e)
      assert.doesNotMatch(outcome?.message ?? '', /Already connected/)
    })
  }

  test('[REL-4] the reconnect window counts as live', async (t) => {
    const h = ipc.fresh(world({ settings: { activeWalletId: 'w1', autoReconnect: true } }))
    t.after(() => h.dispose())
    await connect(h)
    h.tunnel.down()
    await h.advance(5_000)
    const err = await h.settleError(h.invoke('WALLET_SWITCH', 'w2'))
    assert.match(err.message, /Already connected/)
    assert.deepEqual(walletCalls(h), [])
  })

  test('[REL-4] the session carrying the connection cannot be ended from under it (proxy mode)', async (t) => {
    const h = ipc.fresh(world({ fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => 'v2ray' } } }))
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: 2, proxyMode: true }))
    await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'v2ray', mode: 'proxy' }))
    const err = await h.settleError(h.invoke('WALLET_END_SESSION', '1001'))
    assert.match(err.message, /carrying your connection/)
    assert.deepEqual(h.calls('chain/chain-service', 'endSession'), [])
  })

  test('[REL-4] SETTINGS_SET can never write activeWalletId, though the rest of the call goes through', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await h.settle(h.invoke('SETTINGS_SET', { activeWalletId: 'w2', autoReconnect: true }))
    const s = settings(h)
    assert.equal(s.activeWalletId, 'w1', 'only wallet.ts writes activeWalletId')
    assert.equal(s.autoReconnect, true, 'the allowed key in the same call was saved')
  })
})
