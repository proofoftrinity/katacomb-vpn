import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, NODE_WG, merge } from '../../test/harness/requests.ts'
import { INSUFFICIENT_FUNDS, UNREACHABLE_THROUGH_TUNNEL } from '../shared/error-markers.ts'

// [REL-49] Ending a session other than the live one while connected goes through the
// live tunnel. It used to be refused, and the Sessions tab went around it: Disconnect
// (the kill switch lifted with the tunnel), End, Reconnect. In the Windows VM on
// 2026-11-05 that sent about 14 s of traffic out on the real IP with the kill switch on.
// Every test connects to #1001 (the harness's first purchase) and ends #2001, an older
// session on another node.

const ipc = await loadIpcHandlers()

const OTHER_NODE = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqother'
const row = (id: string, nodeAddress: string, extra: Record<string, unknown> = {}) => ({
  id, nodeAddress, status: 'active', downloadBytes: '0', uploadBytes: '0', maxBytes: '1000000000',
  durationSeconds: 0, maxDurationSeconds: null, inactiveAt: null, startAt: '2026-11-05T00:00:00Z',
  subscriptionId: null, priceDenom: 'udvpn', priceValue: '5000000', ...extra,
})

/** The chain's rows; an End the fake chain accepts moves its row to inactive_pending, as x/session does. */
function world(extra: FreshOptions = {}): { opts: FreshOptions; rows: ReturnType<typeof row>[] } {
  const rows = [row('1001', NODE_WG), row('2001', OTHER_NODE)]
  return {
    rows,
    opts: merge({
      chainSessions: rows,
      settings: { killSwitch: true },
      fakes: { 'chain/chain-service': {
        endSession: async (p: { sessionId: string }) => {
          const r = rows.find((s) => s.id === p.sessionId)
          if (r) r.status = 'inactive_pending'
        },
      } },
    }, extra),
  }
}

/** As the renderer runs it: the Sessions tab has read the list, then the user connects. */
async function connected(h: IpcHarness): Promise<void> {
  await h.settle(h.invoke('WALLET_SESSIONS'))
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
  await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' }))
  assert.equal(h.tunnel.up, true)
}

const ended = (h: IpcHarness) => h.calls('chain/chain-service', 'endSession').map((c) => (c.args[0] as { sessionId: string }).sessionId)
const verbsSince = (h: IpcHarness, from: number) =>
  h.world.log.slice(from).filter((c) => c.fn === 'runPrivileged').map((c) => (c.args[0] as string[])[0])
const listed = async (h: IpcHarness) => await h.settle(h.invoke('WALLET_SESSIONS')) as { id: string; status: string; downloadBytes: string }[]

describe('[REL-49] ending another session while connected goes through the live tunnel', () => {
  test('[REL-49] the session is ended through the tunnel: the tunnel and the kill switch stay, and its card reads ended', async (t) => {
    const { opts } = world()
    const h = ipc.fresh(opts)
    t.after(() => h.dispose())
    await connected(h)
    const from = h.world.log.length
    await h.settle(h.invoke('WALLET_END_SESSION', '2001'))
    assert.deepEqual(ended(h), ['2001'])
    assert.equal(h.tunnel.up, true, 'the connection stays up')
    assert.deepEqual(h.world.log.slice(from).filter((c) => c.fn === 'disconnect'), [], 'nothing is torn down')
    assert.ok(!verbsSince(h, from).includes('killswitch-off'), `the firewall stays shut: ${verbsSince(h, from).join(', ')}`)
    const rows = await listed(h)
    assert.equal(rows.find((s) => s.id === '2001')?.status, 'inactive_pending', 'the ended card reads ended while connected')
    assert.equal(rows.find((s) => s.id === '1001')?.status, 'active')
  })

  test('[REL-49] the session carrying the connection is still refused, with nothing sent', async (t) => {
    const { opts } = world()
    const h = ipc.fresh(opts)
    t.after(() => h.dispose())
    await connected(h)
    const err = await h.settleError(h.invoke('WALLET_END_SESSION', '1001'))
    assert.match(err.message, /carrying your connection/)
    assert.deepEqual(ended(h), [])
    await h.settle(h.invoke('WALLET_END_SESSION', '2001')) // control: another one ends
    assert.deepEqual(ended(h), ['2001'])
  })

  test('[REL-49] the End and the read after it go on sockets of their own, since a pooled one may predate the tunnel', async (t) => {
    // [REL-28] A socket pooled before the connect leaves on the physical NIC once the
    // kill switch is armed, and is dropped with nothing to say so: a call on it hangs.
    const fresh = (o?: { freshSockets?: boolean }) => ({ fresh: o?.freshSockets === true })
    let h: IpcHarness | undefined
    const onSocket = <T>(client: unknown, answer: () => T): Promise<T> =>
      h?.tunnel.up && (client as { fresh?: boolean } | undefined)?.fresh !== true ? new Promise<never>(() => undefined) : Promise.resolve(answer())
    const { opts, rows } = world({ fakes: {
      'chain/chain-clients': {
        openChainFlow: async (_w, o) => ({ query: fresh(o), signing: fresh(o), disconnect: () => undefined }) as never,
        openChainQuery: async (o) => ({ query: fresh(o), protobufRpc: {}, disconnect: () => undefined }) as never,
      },
      'chain/wallet': { getActiveSessions: (c) => onSocket(c, () => rows as never) },
    } })
    const answered = opts.fakes!['chain/chain-service']!.endSession!
    opts.fakes!['chain/chain-service']!.endSession = async (p) => {
      await onSocket(p.client, () => undefined)
      await answered(p)
    }
    h = ipc.fresh(opts)
    t.after(() => h!.dispose())
    await connected(h)
    await h.settle(h.invoke('WALLET_END_SESSION', '2001'))
    assert.deepEqual(ended(h), ['2001'], 'the first End went through')
    assert.equal((await listed(h)).find((s) => s.id === '2001')?.status, 'inactive_pending')
  })

  test('[REL-49] only the ended row is read again: the live row keeps the figure its gauge adds this connection to', async (t) => {
    const { opts, rows } = world()
    const h = ipc.fresh(opts)
    t.after(() => h.dispose())
    await connected(h)
    const before = (await listed(h)).find((s) => s.id === '1001')!.downloadBytes
    // The node has reported part of this connection by now. The live gauge adds the
    // tunnel's own count to the cached row, so the fresher figure would count it twice.
    rows[0].downloadBytes = '400000000'
    await h.settle(h.invoke('WALLET_END_SESSION', '2001'))
    assert.equal((await listed(h)).find((s) => s.id === '1001')?.downloadBytes, before)
  })

  for (const [what, message] of [
    ['an RPC connect that timed out', 'RPC connect timed out after 10000ms'],
    ['a request that never answered', 'The operation was aborted'],
    ['an End that ran out of time', 'end timed out after 30000ms'],
  ] as const) {
    test(`[REL-49] ${what} through the tunnel is tried twice, then marked so the renderer can offer to go around`, async (t) => {
      const { opts } = world({ fakes: { 'chain/chain-service': { endSession: async () => { throw new Error(message) } } } })
      const h = ipc.fresh(opts)
      t.after(() => h.dispose())
      await connected(h)
      const from = h.world.log.length
      const err = await h.settleError(h.invoke('WALLET_END_SESSION', '2001'))
      assert.ok(err.message.startsWith(`${UNREACHABLE_THROUGH_TUNNEL}: `), err.message)
      assert.match(err.message, /#2001/)
      assert.deepEqual(ended(h), ['2001', '2001'])
      assert.equal(h.tunnel.up, true)
      assert.ok(!verbsSince(h, from).includes('killswitch-off'))
    })
  }

  for (const [what, message] of [
    ['a wallet that cannot pay the fee', `${INSUFFICIENT_FUNDS}: The transaction was rejected: your wallet doesn't have enough P2P to cover it plus the network fee.`],
    ['a cancel the chain rejected', 'End session failed: unauthorized'],
    ['a cancel that may still land', 'The cancel transaction timed out before confirmation. It may still be processing.'],
  ] as const) {
    test(`[REL-49] ${what} is not marked: going around the tunnel would not change the chain's answer`, async (t) => {
      const { opts } = world({ fakes: { 'chain/chain-service': { endSession: async () => { throw new Error(message) } } } })
      const h = ipc.fresh(opts)
      t.after(() => h.dispose())
      await connected(h)
      const err = await h.settleError(h.invoke('WALLET_END_SESSION', '2001'))
      assert.ok(!err.message.includes(UNREACHABLE_THROUGH_TUNNEL), err.message)
      assert.ok(err.message.includes(message), err.message)
    })
  }
})
