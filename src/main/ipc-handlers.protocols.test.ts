import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, PROTOCOL_BY_TYPE, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, merge, NODE_WG } from '../../test/harness/requests.ts'
import { read, parse, nodes } from '../../test/harness/source.ts'
import ts from 'typescript'

// What CONNECTION_CONNECT and the reconnect ladder do differently per protocol
// (docs/invariants/reliability.md, docs/protocols.md): every branch proves its tunnel
// carries traffic [REL-17]; a live core is not yet a tunnel [REL-18]; the user's
// resolver replaces a WireGuard node's DNS list [REL-9]; local-proxy mode is replayed,
// never persisted [PRO-7]; and the monitor rebuilds what was intended, not what
// vpn-manager last saw [REL-2].

const ipc = await loadIpcHandlers()

const TYPE_OF: Record<string, number> = Object.fromEntries(Object.entries(PROTOCOL_BY_TYPE).map(([t, p]) => [p, Number(t)]))
const BRING_UP: Record<string, string> = {
  wireguard: 'connectWireGuardFromConfig', amneziawg: 'connectAmneziaWgFromConfig', openvpn: 'connectOpenVpnFromConfig',
  v2ray: 'connectV2RayFromConfig', xray: 'connectXRayFromConfig', hysteria2: 'connectHysteria2FromConfig',
}

/** A world whose node runs `protocol`, its handshake building `configString`. */
function nodeRunning(protocol: string, configString = `cfg-${protocol}`): FreshOptions {
  return { fakes: {
    'nodes/node-tester': { fetchNodeServiceType: async () => protocol },
    'chain/chain-service': {
      performHandshake: async () => ({ protocol, configString }) as never,
      loadSessionConfig: (id: string) => ({ sessionId: id, nodeAddress: NODE_WG, protocol, configString }) as never,
    },
  } }
}

async function buyAndConnect(h: IpcHarness, protocol: string, mode?: 'proxy'): Promise<unknown> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: TYPE_OF[protocol], ...(mode ? { proxyMode: true } : {}) }))
  return h.settle(h.invoke('CONNECTION_CONNECT', { protocol, ...(mode ? { mode } : {}) }))
}

describe('[REL-17] every bring-up proves the tunnel carries traffic', () => {
  for (const protocol of Object.keys(BRING_UP)) {
    test(`[REL-17] ${protocol}: an interface that carries nothing fails the connect and is torn down`, async (t) => {
      const h = ipc.fresh(nodeRunning(protocol))
      t.after(() => h.dispose())
      await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: TYPE_OF[protocol] }))
      h.tunnel.carries = false
      const err = await h.settleError(h.invoke('CONNECTION_CONNECT', { protocol }))
      assert.doesNotMatch(err.message, /Already connected|No .* config/)
      assert.equal(h.calls('vpn/vpn-manager', BRING_UP[protocol]).length, 1, 'it was brought up')
      assert.equal(h.tunnel.up, false, 'and then torn down, never reported')
      assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').filter(([s]) => s === 'connected'), [])
    })
  }

  test('[REL-17] the probe host being down is not the tunnel\'s fault: inbound bytes alone pass it', async (t) => {
    const h = ipc.fresh(merge(nodeRunning('wireguard'), { fakes: { 'net-fetch': { fetchFreshSocket: async () => ({ status: 0 }) as never } } }))
    t.after(() => h.dispose())
    await buyAndConnect(h, 'wireguard') // carries: every read sees ~200 KB more inbound
    assert.equal(h.tunnel.up, true)
    assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').at(-1), ['connected'])
  })

  test('[REL-17] local-proxy mode changes no routing, so nothing is probed and the connect stands', async (t) => {
    const h = ipc.fresh(nodeRunning('v2ray'))
    t.after(() => h.dispose())
    h.tunnel.carries = false
    await buyAndConnect(h, 'v2ray', 'proxy')
    assert.equal(h.tunnel.up, true)
    assert.deepEqual(h.calls('net-fetch', 'fetchFreshSocket'), [])
  })

  test('[REL-17] an auto-reconnect that brings back a tunnel carrying nothing is a failed attempt, not a success', async (t) => {
    const h = ipc.fresh(merge(nodeRunning('wireguard'), { settings: { autoReconnect: true } }))
    t.after(() => h.dispose())
    await buyAndConnect(h, 'wireguard')
    const connected = () => h.sent('CONNECTION_STATE_CHANGE').filter(([s]) => s === 'connected').length
    const before = connected()
    h.tunnel.carries = false
    h.tunnel.down() // the interface drops; the monitor notices within 5 s
    await h.advance(5_000 + 2_000 + 60_000) // attempt 1 after its 2 s backoff, proof window and all
    assert.ok(h.calls('vpn/vpn-manager', 'connectWireGuardFromConfig').length >= 2, 'the ladder brought the interface back')
    assert.equal(connected(), before, 'a dead tunnel is never announced as reconnected')
    assert.equal(h.tunnel.up, false, 'the attempt tore down what it built')
    assert.ok(h.sent('CONNECTION_RECONNECTING').length >= 2, 'and the ladder moved on to its next attempt')
  })
})

test('[REL-18] the startup wait asks whether the core is alive, not whether traffic flows: tun-up comes after it', async (t) => {
  // vpn-manager's real status: a live core in tunnel mode is NOT connected until
  // tun2socks is up (the polkit dialog for tun-up is still open).
  let tunUp = false
  const h = ipc.fresh(merge(nodeRunning('v2ray'), { fakes: { 'vpn/vpn-manager': {
    getConnectionStatus: () => ({ connected: h.tunnel.up && tunUp, protocol: tunUp ? 'v2ray' : null, proxyMode: false }),
    bringUpV2RayTunnel: async () => { tunUp = true },
    disconnect: async () => { h.tunnel.down(); tunUp = false },
  } } }))
  t.after(() => h.dispose())
  await buyAndConnect(h, 'v2ray')
  assert.equal(tunUp, true, 'the connect went on to bring up tun2socks')
  assert.deepEqual(h.sent('CONNECTION_STATE_CHANGE').at(-1), ['connected'])
})

describe('[REL-9] the chosen resolver replaces a WireGuard node\'s DNS list, on the WireGuard family only', () => {
  const NODE_DNS = (body: string) => `[Interface]\nAddress = 10.8.0.2/32\nDNS = 10.8.0.1, 1.0.0.1\n${body}[Peer]\nEndpoint = 203.0.113.7:51820\n`
  const CASES: Array<[string, string, (cfg: string) => void]> = [
    ['wireguard', '1.1.1.1', (cfg) => assert.match(cfg, /^DNS = 1\.1\.1\.1$/m)],
    ['amneziawg', '9.9.9.9', (cfg) => assert.match(cfg, /^DNS = 9\.9\.9\.9$/m)],
    ['wireguard', 'system', (cfg) => assert.match(cfg, /^DNS = 10\.8\.0\.1, 1\.0\.0\.1$/m, 'system keeps the node\'s list')],
    ['amneziawg', 'system', (cfg) => assert.match(cfg, /^DNS = 10\.8\.0\.1, 1\.0\.0\.1$/m)],
  ]
  for (const [protocol, dnsResolver, check] of CASES) {
    test(`[REL-9] ${protocol} with dnsResolver=${dnsResolver}`, async (t) => {
      const h = ipc.fresh(merge(nodeRunning(protocol, NODE_DNS(protocol === 'amneziawg' ? 'Jc = 4\n' : '')), { settings: { dnsResolver } }))
      t.after(() => h.dispose())
      await buyAndConnect(h, protocol)
      const cfg = h.calls('vpn/vpn-manager', BRING_UP[protocol])[0].args[0] as string
      check(cfg)
      assert.equal(cfg.match(/^DNS =/gm)?.length, 1, 'replaced, never appended')
    })
  }

  // Found by this suite (2026-10-07): the reconnect ladder replays the SAVED config,
  // which is the handshake's, so it still carries the node's DNS list. A user who
  // chose a resolver is back on the node's after any drop, and the node's resolver
  // sees every name they look up. Awaiting the user's approval to fix.
  for (const protocol of ['wireguard', 'amneziawg']) {
    test(`[REL-9] ${protocol}: an auto-reconnect keeps the chosen resolver too`, { todo: 'found 2026-10-07, fix awaits approval' }, async (t) => {
      const h = ipc.fresh(merge(nodeRunning(protocol, NODE_DNS(protocol === 'amneziawg' ? 'Jc = 4\n' : '')), { settings: { dnsResolver: '1.1.1.1', autoReconnect: true } }))
      t.after(() => h.dispose())
      await buyAndConnect(h, protocol)
      h.tunnel.down()
      await h.advance(5_000 + 2_000)
      const ups = h.calls('vpn/vpn-manager', BRING_UP[protocol])
      assert.equal(ups.length, 2, 'the ladder brought it back')
      assert.match(ups[1].args[0] as string, /^DNS = 1\.1\.1\.1$/m)
    })
  }

  for (const protocol of ['v2ray', 'openvpn']) {
    test(`[REL-9] ${protocol} is not rewritten: its DNS is not wg-quick's to hand to resolvconf`, async (t) => {
      const h = ipc.fresh(merge(nodeRunning(protocol), { settings: { dnsResolver: '1.1.1.1' } }))
      t.after(() => h.dispose())
      await buyAndConnect(h, protocol)
      assert.equal(h.calls('vpn/vpn-manager', BRING_UP[protocol])[0].args[0], `cfg-${protocol}`)
    })
  }
})

describe('[PRO-7] local-proxy mode is runtime only', () => {
  test('[PRO-7] an auto-reconnect replays proxy mode: the core comes back as a proxy, no tun2socks, no root', async (t) => {
    let onExit: () => void = () => undefined
    const h = ipc.fresh(merge(nodeRunning('v2ray'), {
      // The kill switch is on, and deliberately ignored: proxy mode changes no system state.
      settings: { autoReconnect: true, killSwitch: true },
      fakes: { 'vpn/vpn-manager': { onV2RayUnexpectedExit: (cb: () => void) => { onExit = cb } } },
    }))
    t.after(() => h.dispose())
    await buyAndConnect(h, 'v2ray', 'proxy')
    h.tunnel.down()
    onExit() // the core died
    await h.advance(10_000)
    const spawns = h.calls('vpn/vpn-manager', 'connectV2RayFromConfig')
    assert.equal(spawns.length, 2, 'the ladder brought the core back')
    assert.deepEqual(spawns[1].args[2], { proxyOnly: true })
    assert.deepEqual(h.calls('vpn/vpn-manager', 'bringUpV2RayTunnel'), [])
    assert.deepEqual(h.calls('helper/privileged', 'runPrivileged'), [], 'proxy mode never asks for root')
    assert.equal(h.tunnel.mode, 'proxy')
  })

  test('[PRO-7] the mode is never saved with a session: SavedSessionConfig has no field for it', () => {
    const src = parse('src/main/chain/chain-service.ts')
    const saved = nodes(src).filter(ts.isInterfaceDeclaration).find((i) => i.name.text === 'SavedSessionConfig')
    assert.ok(saved, 'SavedSessionConfig moved: re-aim this test')
    const fields = saved.members.map((m) => m.name?.getText(src) ?? '')
    assert.deepEqual(fields.filter((f) => /mode|proxy/i.test(f)), [])
  })

  test('[PRO-7] a Sessions-tab reconnect is always full-tunnel: useReconnect connects with no mode', () => {
    const src = read('src/renderer/hooks/useReconnect.ts')
    const call = src.slice(src.indexOf('window.api.connectionConnect('))
    const args = call.slice(0, call.indexOf('})') + 2)
    assert.match(args, /protocol:/, 'the connect call moved: re-aim this test')
    assert.doesNotMatch(args, /mode/)
  })
})

describe('[REL-2] the monitor rebuilds the protocol the user connected with, not the one vpn-manager last saw', () => {
  for (const protocol of ['wireguard', 'amneziawg', 'openvpn']) {
    test(`[REL-2] ${protocol}: the interface drops, vpn-manager forgets its protocol, and the reconnect still brings back ${protocol}`, async (t) => {
      const h = ipc.fresh(merge(nodeRunning(protocol), { settings: { autoReconnect: true } }))
      t.after(() => h.dispose())
      await buyAndConnect(h, protocol)
      h.tunnel.down()
      assert.equal(h.tunnel.protocol, null, 'vpn-manager\'s activeProtocol is cleared with the interface')
      await h.advance(5_000 + 2_000)
      assert.equal(h.calls('vpn/vpn-manager', BRING_UP[protocol]).length, 2)
      assert.equal(h.tunnel.up, true)
    })
  }
})
