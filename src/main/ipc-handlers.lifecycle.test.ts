import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { SPEND, BRING_UP_CALLS, PURCHASE_CALLS } from '../../test/harness/entry-points.ts'
import { REQUEST, merge, worldFor, NODE_WG } from '../../test/harness/requests.ts'

// The connection state machine in ipc-handlers.ts: one connection at a time, the lock
// and epoch that stop a disconnected tunnel coming back, retry without re-buying, and
// what a reconnect may and may not replay (docs/invariants/reliability.md).

const ipc = await loadIpcHandlers()

const SAVED = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, nodeAddress: NODE_WG, nodeMoniker: 'node-wg', nodeCountry: 'DE',
  protocol: 'wireguard', configString: `cfg-saved-${sessionId}`, ...extra,
}) as never

const bringUps = (h: IpcHarness) => h.calls('vpn/vpn-manager').filter((c) => BRING_UP_CALLS.includes(c.fn))
const purchases = (h: IpcHarness) => h.world.log.filter((c) => PURCHASE_CALLS.includes(c.fn))
const after = <T extends { seq: number }>(xs: T[], mark: number) => xs.filter((c) => c.seq >= mark)
const mark = (h: IpcHarness) => h.world.log.length

/** Buy a WireGuard session and connect it. */
async function connectWireGuard(h: IpcHarness): Promise<void> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
  await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' }))
  assert.equal(h.tunnel.up, true)
}

type Mode = { name: string; world: FreshOptions; enter: (h: IpcHarness) => Promise<void> }
const MODES: Mode[] = [
  { name: 'a tunnel is up', world: {}, enter: connectWireGuard },
  {
    name: 'a local proxy is up (routing untouched, session live)',
    world: { fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => 'v2ray' } } },
    async enter(h) {
      await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: 2, proxyMode: true }))
      await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'v2ray', mode: 'proxy' }))
      assert.equal(h.tunnel.mode, 'proxy')
    },
  },
  {
    name: 'a reconnect is waiting out its backoff',
    world: { settings: { autoReconnect: true }, fakes: { 'chain/chain-service': { loadSessionConfig: () => SAVED('1001') } } },
    async enter(h) {
      await connectWireGuard(h)
      h.tunnel.down() // the interface vanishes under us
      await h.advance(5_000) // the root monitor notices and schedules attempt 1
      assert.equal(h.sent('CONNECTION_RECONNECTING').length, 1, 'the reconnect window was entered')
    },
  },
]

const ENTRY_POINTS = [...SPEND, 'CONNECTION_CONNECT', 'CONNECTION_RECONNECT'] as const
const requestFor = (key: (typeof ENTRY_POINTS)[number]) =>
  key === 'CONNECTION_CONNECT' ? { protocol: 'wireguard', configString: 'cfg-other' }
    : key === 'CONNECTION_RECONNECT' ? { sessionId: '2001' }
      : REQUEST[key]

describe('[REL-3] one connection at a time, enforced in main', () => {
  for (const mode of MODES) {
    for (const key of ENTRY_POINTS) {
      test(`[REL-3] ${key} is refused while ${mode.name}, and goes through once disconnected`, async (t) => {
        const base = merge(key in REQUEST ? worldFor(key as (typeof SPEND)[number]) : {}, mode.world)
        const h = ipc.fresh(merge(base, { fakes: { 'chain/chain-service': { loadSessionConfig: (id: string) => SAVED(id) } } }))
        t.after(() => h.dispose())
        await mode.enter(h)
        const m = mark(h)
        const ups = h.tunnel.bringUps
        const err = await h.settleError(h.invoke(key, requestFor(key)))
        assert.match(err.message, /Already connected/)
        assert.deepEqual(after(purchases(h), m).map((c) => c.fn), [], 'nothing bought')
        assert.equal(h.tunnel.bringUps, ups, 'nothing brought up')
        // Positive control: the same call is not refused once the connection is gone.
        await h.settle(h.main.performDisconnect() as Promise<void>)
        const outcome = await h.settle(h.invoke(key, requestFor(key))).then(() => null, (e: Error) => e)
        assert.doesNotMatch(outcome?.message ?? '', /Already connected/)
      })
    }
  }
})

describe('[REL-2] the lock and the epoch: a disconnect is final', () => {
  const reconnecting = (): FreshOptions => ({
    settings: { autoReconnect: true },
    fakes: { 'chain/chain-service': { loadSessionConfig: () => SAVED('1001') } },
  })

  test('[REL-2] a disconnect during the reconnect backoff: the pending attempt never brings the tunnel back', async (t) => {
    const h = ipc.fresh(reconnecting())
    t.after(() => h.dispose())
    await connectWireGuard(h)
    h.tunnel.down()
    await h.advance(5_000)
    assert.equal(h.sent('CONNECTION_RECONNECTING').length, 1)
    const m = mark(h)
    await h.settle(h.invoke('CONNECTION_DISCONNECT'))
    await h.advance(120_000) // far past every backoff
    assert.deepEqual(after(bringUps(h), m), [])
    assert.equal(h.tunnel.up, false)
    assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').at(-1), ['idle'])
  })

  test('[REL-2] a disconnect while a reconnect attempt is mid-bring-up leaves the tunnel down', async (t) => {
    let release: () => void = () => undefined
    let attempts = 0
    const h = ipc.fresh(merge(reconnecting(), { fakes: { 'vpn/vpn-manager': {
      connectWireGuardFromConfig: async () => {
        if (attempts++ === 0) { h.tunnel.bringUp('wireguard'); return } // the first connect
        await new Promise<void>((r) => { release = r }) // the reconnect's bring-up hangs here
        h.tunnel.bringUp('wireguard')
      },
    } } }))
    t.after(() => h.dispose())
    await connectWireGuard(h)
    h.tunnel.down()
    await h.advance(5_000 + 2_000) // monitor, then the 2 s backoff: the attempt is now inside the lock
    assert.equal(attempts, 2, 'the reconnect attempt is in flight')
    const disconnecting = h.invoke('CONNECTION_DISCONNECT') // queues behind the lock
    const connectedBefore = h.sent('CONNECTION_STATE_CHANGE').filter(([s]) => s === 'connected').length
    release()
    await h.settle(disconnecting)
    await h.advance(60_000)
    assert.equal(h.tunnel.up, false, 'the tunnel the attempt built was torn down')
    assert.equal(h.sent('CONNECTION_STATE_CHANGE').filter(([s]) => s === 'connected').length, connectedBefore,
      'no "connected" may be announced for a tunnel the user already disconnected')
  })

  test('[REL-2] an attempt that fired while another op held the lock bails if the user disconnected meanwhile', async (t) => {
    let releaseDisarm: () => void = () => undefined
    const h = ipc.fresh(merge(reconnecting(), {
      settings: { autoReconnect: true, killSwitch: true },
      fakes: { 'helper/privileged': {
        // The disarm sits on a polkit prompt, holding the connection lock.
        runPrivileged: async (args: string[]) => { if (args[0] === 'killswitch-off') await new Promise<void>((r) => { releaseDisarm = r }) },
      } },
    }))
    t.after(() => h.dispose())
    await connectWireGuard(h)
    h.tunnel.down()
    await h.advance(5_000) // attempt 1 scheduled, 2 s backoff
    await h.settle(h.invoke('SETTINGS_SET', { killSwitch: false })) // the disarm takes the lock in the background
    await h.advance(3_000) // the backoff ends: the attempt fires and queues behind the disarm
    const m = mark(h)
    const disconnecting = h.invoke('CONNECTION_DISCONNECT')
    releaseDisarm()
    await h.settle(disconnecting)
    await h.advance(60_000)
    assert.deepEqual(after(bringUps(h), m), [], 'the queued attempt must see the epoch moved and bail')
    assert.equal(h.tunnel.up, false)
  })

  // Found by the static lock check (2026-10-07), fixed with the user's approval: the
  // reconnect give-up tore down outside the lock. The interface monitor never reaches
  // it, but the V2Ray exit callback has no reconnectAttempt guard, so a core dying
  // during the last attempt ran the teardown while that attempt was mid-bring-up.
  test('[REL-2] a core dying during the last reconnect attempt cannot tear down under it', async (t) => {
    let exitCb: () => void = () => undefined
    let release: (() => void) | null = null
    let spawns = 0
    let hang = false
    const h = ipc.fresh({
      settings: { autoReconnect: true },
      fakes: {
        'nodes/node-tester': { fetchNodeServiceType: async () => 'v2ray' },
        'chain/chain-service': { loadSessionConfig: () => SAVED('1001', { protocol: 'v2ray', configString: 'cfg-v2ray' }) },
        'vpn/vpn-manager': {
          onV2RayUnexpectedExit: (cb: () => void) => { exitCb = cb },
          connectV2RayFromConfig: () => {
            spawns++
            // The first connect works; reconnect attempts 1-4 bring up dead tunnels; attempt 5 is slow.
            h.tunnel.carries = spawns === 1 || spawns >= 6
            hang = spawns >= 6
            h.tunnel.bringUp('v2ray')
          },
          waitForChildProxyListener: async () => {
            if (hang) { hang = false; await new Promise<void>((r) => { release = r }) }
          },
        },
      },
    })
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: 2 }))
    await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'v2ray' }))
    h.tunnel.down()
    exitCb() // the core died: the ladder starts
    for (let t = 0; t < 180_000 && !release; t += 1_000) await h.advance(1_000)
    assert.ok(release, 'reconnect attempt 5 is in flight, holding the lock')
    const m = mark(h)
    exitCb() // attempt 5's core reports an exit: the ladder is out of attempts, so this is a give-up
    await h.advance(2_000)
    assert.deepEqual(after(h.calls('vpn/vpn-manager', 'disconnect'), m), [], 'the give-up must wait for the attempt that holds the lock')
    release!()
    await h.advance(30_000)
    assert.equal(h.tunnel.up, true, 'attempt 5 succeeded, so the stale give-up stands aside')
    assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').at(-1), ['connected'])
  })

  test('when every attempt fails the ladder still gives up: tunnel down, idle, ready to connect again', async (t) => {
    const h = ipc.fresh(reconnecting())
    t.after(() => h.dispose())
    await connectWireGuard(h)
    h.tunnel.down()
    h.tunnel.carries = false // every attempt brings up a tunnel that answers nothing
    await h.advance(5_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 30_000)
    assert.equal(h.sent('CONNECTION_RECONNECTING').length, 5)
    assert.equal(h.tunnel.up, false)
    assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').at(-1), ['idle'])
    // The ladder is over, so a new connect is not refused as "already connected".
    h.tunnel.carries = true
    const outcome = await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard', configString: 'cfg-new' })).then(() => null, (e: Error) => e)
    assert.equal(outcome, null)
  })

  test('[REL-2] [REL-3] a connect queued behind another connect sees the first tunnel and is refused', async (t) => {
    let release: () => void = () => undefined
    const h = ipc.fresh({ fakes: { 'vpn/vpn-manager': {
      connectWireGuardFromConfig: async () => { await new Promise<void>((r) => { release = r }); h.tunnel.bringUp('wireguard') },
    } } })
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    const first = h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' })
    // Its refusal lands while the first is still settling: hold it as a value.
    const second = h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' }).then(() => null, (e: Error) => e)
    await h.advance(1_000)
    release()
    await h.settle(first)
    assert.match((await h.settle(second))?.message ?? 'second connect succeeded', /Already connected/)
    assert.equal(h.tunnel.bringUps, 1)
  })
})

describe('[REL-13] retry, do not re-buy', () => {
  test('[REL-13] [REL-17] a tunnel that carries nothing fails the connect, keeps the paid config, and Retry reuses it', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE', REQUEST.CONNECTION_SUBSCRIBE))
    h.tunnel.carries = false
    const err = await h.settleError(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' }))
    assert.doesNotMatch(err.message, /Already connected/)
    assert.equal(h.tunnel.up, false, 'a tunnel that carries nothing is torn down, never reported')
    assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').filter(([s]) => s === 'connected'), [], '[REL-27] never announced as connected')
    h.tunnel.carries = true
    await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'wireguard' })) // Retry: no configString
    assert.equal(h.tunnel.up, true)
    assert.equal(h.calls('chain/chain-service', 'subscribeToNode').length, 1, 'bought once')
    assert.deepEqual(h.calls('vpn/vpn-manager', 'connectWireGuardFromConfig').map((c) => c.args[0]), ['cfg-wireguard', 'cfg-wireguard'])
  })
})

describe('reconnecting a saved session', () => {
  test('[REL-19] a 409 means the node kept the record: the saved config is replayed, no purchase', async (t) => {
    const h = ipc.fresh({ fakes: { 'chain/chain-service': {
      loadSessionConfig: (id: string) => SAVED(id),
      performHandshake: async () => { throw Object.assign(new Error('conflict'), { response: { status: 409 } }) },
    } } })
    t.after(() => h.dispose())
    const res = await h.settle(h.invoke('CONNECTION_RECONNECT', { sessionId: '2001' })) as { configString: string }
    assert.equal(res.configString, 'cfg-saved-2001')
    assert.equal(h.calls('chain/chain-service', 'performHandshake').length, 1, 'the renewal is tried first')
    assert.deepEqual(purchases(h), [])
  })

  test('[MH-9] a tombstone (credentials cleared) is refused, not brought up empty', async (t) => {
    const h = ipc.fresh({ fakes: { 'chain/chain-service': { loadSessionConfig: (id: string) => SAVED(id, { configString: '' }) } } })
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_RECONNECT', { sessionId: '2001' }))
    assert.match(err.message, /credentials were cleared/)
    assert.deepEqual(h.calls('chain/chain-service', 'performHandshake'), [])
  })

  test('[MH-10] a chain that has lost a hop is refused rather than rebuilt', async (t) => {
    const h = ipc.fresh({ fakes: { 'chain/chain-service': {
      loadSessionConfig: (id: string) => id === '3001'
        ? SAVED(id, { protocol: 'xray', chainPeerSessionId: '3002', chainRole: 'entry' })
        : SAVED(id, { protocol: 'xray', chainPeerSessionId: '3001', chainRole: 'exit', configString: '' }),
    } } })
    t.after(() => h.dispose())
    const err = await h.settleError(h.invoke('CONNECTION_RECONNECT', { sessionId: '3001' }))
    assert.match(err.message, /hop of this chain \(#3002\) has ended/)
    assert.equal(h.tunnel.bringUps, 0)
  })

  // Found by this suite (2026-10-07), fixed with the user's approval. CONNECTION_CONNECT
  // preferred the STASHED WireGuard / V2Ray config over the one it was handed, and
  // RECONNECT re-points the session without clearing that stash. So: a connect of
  // session A failed (its config stays stashed for Retry), the user reconnected
  // session B from the Sessions tab, the node answered 409, and CONNECT brought up
  // A's tunnel while the watchdog tracked B.
  for (const [protocol, nodeType] of [['wireguard', 1], ['v2ray', 2]] as const) {
    test(`[REL-13] ${protocol}: a reconnect brings up the config it returned, not one stashed by an earlier failed connect`, async (t) => {
      const h = ipc.fresh({ fakes: {
        'nodes/node-tester': { fetchNodeServiceType: async () => protocol },
        'chain/chain-service': {
          loadSessionConfig: (id: string) => SAVED(id, { protocol }),
          performHandshake: async (p: { sessionId: string }) => {
            if (p.sessionId === '1001') return { protocol, configString: 'cfg-A' } as never
            throw Object.assign(new Error('conflict'), { response: { status: 409 } })
          },
        },
      } })
      t.after(() => h.dispose())
      await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType })) // session A = 1001
      h.tunnel.carries = false
      await h.settleError(h.invoke('CONNECTION_CONNECT', { protocol })) // A fails, stays stashed for Retry
      h.tunnel.carries = true
      const res = await h.settle(h.invoke('CONNECTION_RECONNECT', { sessionId: '2001' })) as { protocol: string; configString: string }
      await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: res.protocol, configString: res.configString }))
      const bringUp = protocol === 'wireguard' ? 'connectWireGuardFromConfig' : 'connectV2RayFromConfig'
      assert.equal(h.calls('vpn/vpn-manager', bringUp).at(-1)?.args[0], 'cfg-saved-2001')
    })
  }
})

describe('what CONNECTION_CONNECT accepts', () => {
  for (const protocol of ['wireguard', 'amneziawg', 'openvpn']) {
    test(`[PRO-7] local-proxy mode is refused for ${protocol}, which routes the whole device`, async (t) => {
      const h = ipc.fresh({})
      t.after(() => h.dispose())
      const err = await h.settleError(h.invoke('CONNECTION_CONNECT', { protocol, mode: 'proxy', configString: 'cfg' }))
      assert.match(err.message, /Local-proxy mode is not available/)
      assert.equal(h.tunnel.bringUps, 0)
    })
  }

  for (const key of ['CONNECTION_SUBSCRIBE', 'PLAN_SUBSCRIBE', 'PLAN_START_SESSION_FROM_SUB'] as const) {
    test(`[PRO-1] ${key} refuses a nodeType outside 1..6 before anything else`, async (t) => {
      const h = ipc.fresh({})
      t.after(() => h.dispose())
      for (const nodeType of [0, 7, -1, 2.5]) {
        const err = await h.settleError(h.invoke(key, { ...REQUEST[key], nodeType }))
        assert.match(err.message, /nodeType/)
      }
      assert.deepEqual(h.world.log.filter((c) => c.mod !== 'ipc/diagnostics' && c.mod !== 'ipc/setup' && c.mod !== 'ipc/provider' && c.fn !== 'onV2RayUnexpectedExit'), [])
    })
  }
})
