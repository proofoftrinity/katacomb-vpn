import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadIpcHandlers, PROTOCOL_BY_TYPE, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, NODE_WG, merge, worldFor } from '../../test/harness/requests.ts'

// Extend ([REL-46]): buy a new session on the node the tunnel runs through, move the
// tunnel onto it, end the old one. It is [REL-3]'s one exception (it runs only while
// connected), so the matrices that loop over the purchase handlers from idle do not
// cover it; these do. Every test starts connected to session #1001 on NODE_WG, and the
// Extend buys #1002.

const ipc = await loadIpcHandlers()
const windows = await loadIpcHandlers({ windows: true })

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nodeAddress: NODE_WG, status: 'active', downloadBytes: '0', uploadBytes: '0', maxBytes: '1000000000',
  durationSeconds: 0, maxDurationSeconds: null, inactiveAt: null, startAt: '2026-10-06T23:59:00Z',
  subscriptionId: null, priceDenom: 'udvpn', priceValue: '5000000', ...extra,
})

/** The node as the directory lists it: its version is how D3 tells dvpnx from dvpnd. */
const listed = (version: string, type = 1) => ({
  address: NODE_WG, moniker: 'node-wg', country: 'DE', type, api: 'https://203.0.113.7:8585', isActive: true, isHealthy: true, version,
})

const EXTEND = { sessionId: '1001', nodeAddress: NODE_WG, type: 'gigabytes', amount: 2, denom: 'udvpn', quoteValue: '5000000' }

/** A dvpnx WireGuard node, both sessions readable on chain. */
function world(extra: FreshOptions = {}, nodeType = 1): FreshOptions {
  const protocol = PROTOCOL_BY_TYPE[nodeType]
  return merge({
    chainSessions: [row('1001'), row('1002')],
    nodes: [listed('8.3.1', nodeType)],
    fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => protocol } },
  }, extra)
}

async function connected(h: IpcHarness, nodeType = 1, mode?: 'proxy'): Promise<void> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType }))
  await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: PROTOCOL_BY_TYPE[nodeType], ...(mode ? { mode } : {}) }))
  assert.equal(h.tunnel.up, true)
}

const bought = (h: IpcHarness) => h.calls('chain/chain-service', 'subscribeToNode').length
const ended = (h: IpcHarness) => h.calls('chain/chain-service', 'endSession').map((c) => (c.args[0] as { sessionId: string }).sessionId)
const status = async (h: IpcHarness) => await h.settle(h.invoke('CONNECTION_STATUS')) as {
  state: string; sessionId?: string; expired?: { sessionId: string; reason: string; nodeAddress?: string }
}
/** A promise and the function that settles it, to hold a faked call open. */
function gate<T = void>(): { wait: Promise<T>; open: (v: T) => void } {
  let open: (v: T) => void = () => undefined
  const wait = new Promise<T>((r) => { open = r })
  return { wait, open }
}

describe('[REL-46] Extend replaces the live session in one step', () => {
  test('[REL-46] buys on the same node, switches the tunnel to the new session, then ends the old one', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await connected(h)
    const from = h.world.log.length
    const res = await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.deepEqual(res, { sessionId: '1002', previousSessionId: '1001', previousEnded: true })
    const steps = h.world.log.slice(from)
      .filter((c) => ['subscribeToNode', 'performHandshake', 'disconnect', 'connectWireGuardFromConfig', 'endSession'].includes(c.fn))
      .map((c) => (c.fn === 'endSession' ? `endSession #${(c.args[0] as { sessionId: string }).sessionId}` : c.fn))
    assert.deepEqual(steps, ['subscribeToNode', 'performHandshake', 'disconnect', 'connectWireGuardFromConfig', 'endSession #1001'],
      'nothing changes before the new handshake answers, and the old session ends only once the new tunnel is up')
    const buy = h.calls('chain/chain-service', 'subscribeToNode').at(-1)!.args[0] as Record<string, unknown>
    assert.deepEqual([buy.nodeAddress, buy.type, buy.amount], [NODE_WG, 'gigabytes', 2])
    assert.equal(h.tunnel.up, true)
    const s = await status(h)
    assert.deepEqual([s.state, s.sessionId], ['connected', '1002'])
  })

  test('[REL-46] the old session\'s usage is floored before its tunnel goes', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await connected(h)
    await h.advance(30_000)
    await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    const usage = JSON.parse(readFileSync(join(h.world.userData, 'session-usage.json'), 'utf-8')) as Record<string, { downloadBytes: string }>
    assert.ok(Number(usage['1001']?.downloadBytes) > 0, 'what the old tunnel carried is recorded against the old session')
  })

  test('[REL-46] the new session is the one the watchdog scores', async (t) => {
    // #1002 holds 1 MB: the faked tunnel moves ~220 KB a read, so a few ticks spend it.
    const h = ipc.fresh(world({ chainSessions: [row('1001'), row('1002', { maxBytes: '1000000' })] }))
    t.after(() => h.dispose())
    await connected(h)
    await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    await h.advance(120_000)
    const s = await status(h)
    assert.deepEqual([s.state, s.expired?.sessionId, s.expired?.reason], ['idle', '1002', 'data'])
    assert.equal(s.expired?.nodeAddress, NODE_WG, 'D4: the banner offers to buy on that node again')
  })

  test('[REL-46] the kill switch stays armed through the switch', async (t) => {
    const h = ipc.fresh(world({ settings: { killSwitch: true } }))
    t.after(() => h.dispose())
    await connected(h)
    const from = h.world.log.length
    await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    const verbs = h.world.log.slice(from).filter((c) => c.fn === 'runPrivileged').map((c) => (c.args[0] as string[])[0])
    assert.ok(!verbs.includes('killswitch-off'), `the switch must not open the firewall: ${verbs.join(', ')}`)
    assert.ok(verbs.includes('killswitch-on'), 'and re-arms it for the new tunnel')
  })

  test('[REL-46] a V2Ray tunnel in proxy mode stays in proxy mode', async (t) => {
    const h = ipc.fresh(world({}, 2))
    t.after(() => h.dispose())
    await connected(h, 2, 'proxy')
    const from = h.world.log.length
    await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    const core = h.world.log.slice(from).filter((c) => c.fn === 'connectV2RayFromConfig')
    assert.equal(core.length, 1)
    assert.deepEqual(core[0].args[2], { proxyOnly: true })
    assert.equal(h.tunnel.mode, 'proxy')
    assert.deepEqual(ended(h), ['1001'])
  })

  test('[REL-46] Windows: the same switch, through the service', async (t) => {
    const h = windows.fresh(world())
    t.after(() => h.dispose())
    await connected(h)
    const res = await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.deepEqual(res, { sessionId: '1002', previousSessionId: '1001', previousEnded: true })
    assert.equal(h.tunnel.up, true)
  })
})

describe('[REL-46] Extend refuses anything but the live single-hop P2P session', () => {
  const refused = async (h: IpcHarness, request: Record<string, unknown>, pattern: RegExp) => {
    const before = { bought: bought(h), up: h.tunnel.up, bringUps: h.tunnel.bringUps }
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', request))
    assert.match(err.message, pattern)
    assert.equal(bought(h), before.bought, 'nothing bought')
    assert.deepEqual([h.tunnel.up, h.tunnel.bringUps], [before.up, before.bringUps], 'the tunnel is untouched')
  }

  test('[REL-46] not connected', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await refused(h, EXTEND, /not connected/)
  })

  test('[REL-46] the connection changed since the window opened', async (t) => {
    const h = ipc.fresh(world())
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, { ...EXTEND, sessionId: '999' }, /changed since this window opened/)
  })

  test('[REL-46] a plan session', async (t) => {
    const h = ipc.fresh(world({ chainSessions: [row('1001', { subscriptionId: '77' })] }))
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, EXTEND, /runs on a plan/)
  })

  test('[REL-46] a two-hop chain', async (t) => {
    const h = ipc.fresh(merge(worldFor('CONNECTION_SUBSCRIBE_CHAIN'), { chainSessions: [row('1001'), row('1002')] }))
    t.after(() => h.dispose())
    await h.settle(h.invoke('CONNECTION_SUBSCRIBE_CHAIN', REQUEST.CONNECTION_SUBSCRIBE_CHAIN))
    await h.settle(h.invoke('CONNECTION_CONNECT', { protocol: 'xray' }))
    await refused(h, { ...EXTEND, nodeAddress: (REQUEST.CONNECTION_SUBSCRIBE_CHAIN.entry as { nodeAddress: string }).nodeAddress }, /two-hop chain/)
  })

  test('[REL-46] mid-reconnect', async (t) => {
    const h = ipc.fresh(world({ settings: { autoReconnect: true } }))
    t.after(() => h.dispose())
    await connected(h)
    h.tunnel.down()
    await h.advance(5_000)
    await refused(h, EXTEND, /reconnecting/)
  })

  test('[REL-46] D3: WireGuard on dvpnd, where the reply would come back through the peer it just dropped', async (t) => {
    const h = ipc.fresh(world({ nodes: [listed('9.4.3')] }))
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, EXTEND, /runs dvpnd/)
  })

  test('[REL-46] D3: WireGuard on a node whose software is unknown', async (t) => {
    const h = ipc.fresh(world({ nodes: [] }))
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, EXTEND, /cannot tell which software/)
  })

  test('[REL-46] D3: dvpnd 9.0.0, which reports the version dvpnx 9.0.0 does, is told by its own root document', async (t) => {
    const h = ipc.fresh(world({
      nodes: [listed('9.0.0')],
      fakes: { 'nodes/node-tester': { fetchNodeSoftware: async () => ({ name: 'dvpnd', tag: '9.0.0' }) } },
    }))
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, EXTEND, /runs dvpnd/)
    assert.equal(h.calls('nodes/node-tester', 'fetchNodeSoftware').length, 1, 'asked of the node, after the directory let it through')
  })

  test('[REL-46] D3: a signed handshake reply is dvpnd whatever the directory says', async (t) => {
    const h = ipc.fresh(world({ fakes: { 'chain/chain-service': {
      performHandshake: async () => ({ protocol: 'wireguard', configString: 'cfg-wireguard', signer: 'node' }) as never,
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    await refused(h, EXTEND, /runs dvpnd/)
  })

  test('[REL-46] D3 control: V2Ray on dvpnd goes ahead, its reply arrives outside the tunnel', async (t) => {
    const h = ipc.fresh(world({ nodes: [listed('9.4.3', 2)] }, 2))
    t.after(() => h.dispose())
    await connected(h, 2)
    const res = await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND)) as { sessionId: string }
    assert.equal(res.sessionId, '1002')
  })
})

describe('[REL-46] a failed Extend loses nothing', () => {
  test('[REL-46] a preflight refusal buys nothing and keeps the old tunnel', async (t) => {
    let checks = 0
    const h = ipc.fresh(world({ fakes: { 'nodes/node-tester': {
      fetchNodeServiceType: async () => { if (checks++ > 0) throw new Error('ETIMEDOUT'); return 'wireguard' },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.match(err.message, /not charged/)
    assert.equal(bought(h), 1)
    assert.equal((await status(h)).sessionId, '1001')
    assert.equal(h.tunnel.up, true)
  })

  test('[REL-46] the balance must cover the new deposit and both fees, the purchase\'s and the End\'s', async (t) => {
    // 2 GB at 5 P2P, plus ONE fee reserve: enough for a plain purchase, not for Extend.
    const balance = String(2 * 5_000_000 + 50_000)
    const h = ipc.fresh(world({ fakes: { 'chain/wallet': { getBalance: async () => [{ denom: 'udvpn', amount: balance }] } } }))
    t.after(() => h.dispose())
    await connected(h)
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.match(err.message, /INSUFFICIENT_FUNDS/)
    assert.equal(bought(h), 1, 'only the original purchase')
  })

  test('[REL-46] a handshake failure refunds the new session and leaves the old tunnel up', async (t) => {
    let handshakes = 0
    const h = ipc.fresh(world({ fakes: { 'chain/chain-service': {
      performHandshake: async () => {
        if (handshakes++ > 0) throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } })
        return { protocol: 'wireguard', configString: 'cfg-wireguard' } as never
      },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const from = h.world.log.length
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.match(err.message, /cancelled/)
    assert.deepEqual(ended(h), ['1002'], 'the session just bought is the one cancelled')
    assert.deepEqual(h.world.log.slice(from).filter((c) => c.fn === 'disconnect'), [], 'the old tunnel was never touched')
    assert.equal((await status(h)).sessionId, '1001')
    assert.equal(h.tunnel.up, true)
  })

  test('[REL-46] a Disconnect while Extend buys: nothing switches, and the session bought for it is ended', async (t) => {
    const held = gate()
    let buys = 0
    const h = ipc.fresh(world({ fakes: { 'chain/chain-service': {
      subscribeToNode: async () => {
        if (buys++ > 0) await held.wait
        return { sessionId: String(1001 + buys - 1), remoteUrl: 'https://203.0.113.7:8585' } as never
      },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const bringUps = h.tunnel.bringUps
    const extending = h.invoke('CONNECTION_EXTEND', EXTEND).then(() => null, (e: Error) => e)
    await h.advance(1_000)
    const disconnecting = h.invoke('CONNECTION_DISCONNECT')
    await h.advance(1_000)
    held.open()
    const err = await h.settle(extending)
    await h.settle(disconnecting)
    assert.match(err?.message ?? '', /connection was closed.*#1002.*was ended/s)
    assert.deepEqual(ended(h), ['1002'])
    assert.equal(h.tunnel.bringUps, bringUps, 'the new session was never brought up')
    assert.equal(h.tunnel.up, false, 'the Disconnect went through')
  })

  test('[REL-46] the new tunnel does not come up: disconnected, both sessions open, and the message names both', async (t) => {
    let bringUps = 0
    const h = ipc.fresh(world({ fakes: { 'vpn/vpn-manager': {
      connectWireGuardFromConfig: async () => {
        if (bringUps++ > 0) throw new Error('wg-quick: RTNETLINK answers: Operation not permitted')
        h.tunnel.bringUp('wireguard')
      },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.match(err.message, /#1002 was bought, but its tunnel did not come up: wg-quick/)
    assert.match(err.message, /#1001 is open too/)
    assert.deepEqual(ended(h), [], 'neither session is ended: either may be the one the user wants back')
    const s = await status(h)
    assert.deepEqual([s.state, s.expired?.sessionId, s.expired?.reason], ['idle', '1002', 'dropped'])
    assert.equal(h.tunnel.up, false)
  })

  test('[REL-46] the old tunnel fails to come down: the switch still ends in a stand-down, nothing left unwatched', async (t) => {
    let teardowns = 0
    const h = ipc.fresh(world({ fakes: { 'vpn/vpn-manager': {
      disconnect: async () => {
        if (teardowns++ === 0) throw new Error('helper: wg-quick down failed')
        h.tunnel.down()
      },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const err = await h.settleError(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.match(err.message, /#1002 was bought.*wg-quick down failed/s)
    assert.deepEqual(ended(h), [])
    const s = await status(h)
    assert.deepEqual([s.state, s.expired?.reason], ['idle', 'dropped'])
    assert.equal(h.tunnel.up, false, 'the stand-down took the tunnel down')
  })

  test('[REL-46] ending the old session is retried once, on a new connection', async (t) => {
    // The first End hangs, as one does on a socket the old WireGuard peer took with it.
    let ends = 0
    const h = ipc.fresh(world({ fakes: { 'chain/chain-service': {
      endSession: () => (ends++ === 0 ? new Promise<never>(() => undefined) : Promise.resolve()),
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const res = await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.deepEqual(res, { sessionId: '1002', previousSessionId: '1001', previousEnded: true })
    assert.deepEqual(ended(h), ['1001', '1001'])
  })

  test('[REL-46] when the old session cannot be ended, the new tunnel stays and the reply says so', async (t) => {
    const h = ipc.fresh(world({ fakes: { 'chain/chain-service': {
      endSession: async () => { throw new Error('RPC connect timed out') },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const res = await h.settle(h.invoke('CONNECTION_EXTEND', EXTEND))
    assert.deepEqual(res, { sessionId: '1002', previousSessionId: '1001', previousEnded: false, previousEndError: 'RPC connect timed out' })
    assert.equal(h.tunnel.up, true)
    assert.equal((await status(h)).sessionId, '1002')
  })
})

describe('[REL-46] while Extend runs it owns the connection', () => {
  /** Hold the second purchase open (the first is the original connect). */
  function heldBuy(extra: FreshOptions = {}): { opts: FreshOptions; release: () => void } {
    const held = gate()
    let buys = 0
    return {
      release: () => held.open(),
      opts: merge(world(extra), { fakes: { 'chain/chain-service': {
        subscribeToNode: async () => {
          if (buys++ > 0) await held.wait
          return { sessionId: String(1001 + buys - 1), remoteUrl: 'https://203.0.113.7:8585' } as never
        },
      } } }),
    }
  }

  test('[REL-46] the old session\'s expiry is held: Extend decides how it ends', async (t) => {
    // #1001 holds 1 MB, which the watchdog would find spent within a few ticks.
    const { opts, release } = heldBuy({ chainSessions: [row('1001', { maxBytes: '1000000' }), row('1002')] })
    const h = ipc.fresh(opts)
    t.after(() => h.dispose())
    await connected(h)
    const extending = h.invoke('CONNECTION_EXTEND', EXTEND)
    await h.advance(90_000)
    assert.equal((await status(h)).expired, undefined, 'no stand-down while Extend runs')
    release()
    const res = await h.settle(extending) as { sessionId: string }
    assert.equal(res.sessionId, '1002')
    assert.equal(h.tunnel.up, true)
  })

  test('[REL-46] control: without Extend, that session is stood down', async (t) => {
    const h = ipc.fresh(world({ chainSessions: [row('1001', { maxBytes: '1000000' }), row('1002')] }))
    t.after(() => h.dispose())
    await connected(h)
    await h.advance(90_000)
    assert.equal((await status(h)).expired?.reason, 'data')
  })

  test('[REL-46] [REL-34] no other connect starts while Extend runs, and Extend waits for one in flight', async (t) => {
    const { opts, release } = heldBuy()
    const h = ipc.fresh(opts)
    t.after(() => h.dispose())
    await connected(h)
    const extending = h.invoke('CONNECTION_EXTEND', EXTEND)
    await h.advance(1_000)
    for (const [key, req] of [['CONNECTION_RECONNECT', { sessionId: '1001' }], ['CONNECTION_EXTEND', EXTEND]] as const) {
      const err = await h.settleError(h.invoke(key, req), 5_000)
      assert.match(err.message, /already being set up/, key)
    }
    release()
    await h.settle(extending)
    assert.equal(bought(h), 2)
  })

  test('[REL-46] [REL-4] during the switch the status reads reconnecting and the wallet stays frozen', async (t) => {
    const held = gate()
    let bringUps = 0
    const h = ipc.fresh(world({ fakes: { 'vpn/vpn-manager': {
      connectWireGuardFromConfig: async () => {
        if (bringUps++ > 0) await held.wait
        h.tunnel.bringUp('wireguard')
      },
    } } }))
    t.after(() => h.dispose())
    await connected(h)
    const extending = h.invoke('CONNECTION_EXTEND', EXTEND)
    await h.advance(1_000)
    assert.equal(h.tunnel.up, false, 'mid-switch: the old tunnel is down')
    assert.equal((await status(h)).state, 'reconnecting')
    const err = await h.settleError(h.invoke('WALLET_SWITCH', 'w2'), 5_000)
    assert.match(err.message, /Disconnect the current session before switching wallets/)
    held.open()
    await h.settle(extending)
    assert.equal((await status(h)).state, 'connected')
  })

  test('[REL-46] [REL-22] the Sessions tab keeps both sessions through the switch, though the chain cannot be read', async (t) => {
    // The status reading reconnecting makes the tab ask again mid-switch, with no tunnel
    // and the kill switch dropping the read, and after a WireGuard switch the next read
    // can hang on a socket the old peer took with it. Each comes back as an empty list.
    const held = gate()
    let bringUps = 0
    let chainReadable = true
    const h = ipc.fresh(world({ fakes: {
      'vpn/vpn-manager': {
        connectWireGuardFromConfig: async () => {
          if (bringUps++ > 0) await held.wait
          h.tunnel.bringUp('wireguard')
        },
      },
      'chain/wallet': { getActiveSessions: async () => (chainReadable ? [row('1001'), row('1002')] : []) },
    } }))
    t.after(() => h.dispose())
    await connected(h)
    const extending = h.invoke('CONNECTION_EXTEND', EXTEND)
    await h.advance(1_000)
    assert.equal(h.tunnel.up, false, 'mid-switch: the old tunnel is down')
    chainReadable = false
    const ids = async () => (await h.settle(h.invoke('WALLET_SESSIONS')) as { id: string }[]).map((s) => s.id).sort()
    assert.deepEqual(await ids(), ['1001', '1002'], 'mid-switch')
    held.open()
    await h.settle(extending)
    assert.deepEqual(await ids(), ['1001', '1002'], 'after the switch, before the chain answers again')
  })
})

describe('[REL-46] the 90% warning points at Extend where Extend would go ahead', () => {
  for (const [kind, rows, named] of [
    ['a per-GB session', [row('1001', { maxBytes: '2000000' })], true],
    ['a plan session', [row('1001', { maxBytes: '2000000', subscriptionId: '77' })], false],
  ] as const) {
    test(`[REL-46] ${kind}: ${named ? 'named' : 'not named'}`, async (t) => {
      const h = ipc.fresh(world({ chainSessions: [...rows] }))
      t.after(() => h.dispose())
      await connected(h)
      let warning: string | undefined
      for (let i = 0; i < 20 && warning === undefined; i++) {
        await h.advance(15_000)
        warning = h.world.notifications.map((n) => n.body ?? '').find((b) => /of your session left/.test(b))
      }
      assert.ok(warning, 'the fixture must reach the warning')
      assert.equal(/Extend it from the Sessions tab\./.test(warning), named, warning)
    })
  }
})

describe('[REL-46] Extend checks what the renderer sends', () => {
  const BAD: Array<[string, unknown]> = [
    ['sessionId', 'abc'], ['nodeAddress', 'sent1notanode'], ['type', 'days'], ['amount', 0], ['amount', 1001], ['quoteValue', '-1'],
  ]
  for (const [field, value] of BAD) {
    test(`[REL-46] a bad ${field} (${JSON.stringify(value)}) is refused before anything else`, async (t) => {
      const h = ipc.fresh(world())
      t.after(() => h.dispose())
      await connected(h)
      const err = await h.settleError(h.invoke('CONNECTION_EXTEND', { ...EXTEND, [field]: value }))
      assert.ok(err instanceof Error)
      assert.equal(bought(h), 1)
    })
  }
})
