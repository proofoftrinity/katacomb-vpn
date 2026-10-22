import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, NODE_WG } from '../../test/harness/requests.ts'

// The connection state machine on Windows (docs/windows.md). Everything else in it is the
// Linux machine, tested in the other ipc-handlers.*.test.ts files; these are what the
// Windows service changes about watching a live tunnel ([REL-45]).

const linux = await loadIpcHandlers()
const windows = await loadIpcHandlers({ windows: true })

const SAVED = (protocol: string) => () => ({
  sessionId: '1001', nodeAddress: NODE_WG, nodeMoniker: 'node-wg', nodeCountry: 'DE',
  protocol, configString: `cfg-saved-${protocol}`,
}) as never

const NODE_TYPE: Record<string, number> = { wireguard: 1, amneziawg: 5 }
const A: Record<string, string> = { wireguard: 'a WireGuard', amneziawg: 'an AmneziaWG' }

async function connect(h: IpcHarness, protocol: 'wireguard' | 'amneziawg'): Promise<void> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: NODE_TYPE[protocol] }))
  await h.settle(h.invoke('CONNECTION_CONNECT', { protocol }))
  assert.equal(h.tunnel.up, true)
}

for (const protocol of ['wireguard', 'amneziawg'] as const) {
  const world = (routeChanged: () => boolean): FreshOptions => ({
    settings: { autoReconnect: true },
    fakes: {
      'nodes/node-tester': { fetchNodeServiceType: async () => protocol },
      'chain/chain-service': { loadSessionConfig: SAVED(protocol) },
      'vpn/vpn-manager': { hasDefaultRouteChanged: async () => routeChanged() },
    },
  })

  test(`[REL-45] Windows: ${A[protocol]} tunnel whose uplink changed is reconnected`, async (t) => {
    let changed = false
    const h = windows.fresh(world(() => changed))
    t.after(() => h.dispose())
    await connect(h, protocol)
    await h.advance(10_000)
    assert.equal(h.sent('CONNECTION_RECONNECTING').length, 0, 'the same uplink: nothing to do')
    changed = true
    await h.advance(5_000)
    assert.equal(h.sent('CONNECTION_RECONNECTING').length, 1, 'the endpoint route points at an uplink that is gone')
  })

  test(`[REL-45] control: on Linux ${A[protocol]} tunnel is not asked about the uplink: its policy routing follows it`, async (t) => {
    const h = linux.fresh(world(() => true))
    t.after(() => h.dispose())
    await connect(h, protocol)
    await h.advance(15_000)
    assert.equal(h.sent('CONNECTION_RECONNECTING').length, 0)
    assert.deepEqual(h.calls('vpn/vpn-manager', 'hasDefaultRouteChanged'), [])
  })
}

const staleHandshake = (h: IpcHarness) => h.calls('helper/daemon-client', 'daemonWireguardHandshakeAge')

test('[REL-45] Windows: an AmneziaWG peer that stopped handshaking is stood down, as WireGuard\'s is', async (t) => {
  const h = windows.fresh({
    fakes: {
      'nodes/node-tester': { fetchNodeServiceType: async () => 'amneziawg' },
      // Past the protocol's own dead line on every tick.
      'helper/daemon-client': { daemonWireguardHandshakeAge: async () => 400 },
    },
  })
  t.after(() => h.dispose())
  await connect(h, 'amneziawg')
  await h.advance(15_000 * 4)
  assert.ok(staleHandshake(h).length >= 3, 'the service\'s device is asked for AmneziaWG too')
  assert.equal(h.tunnel.up, false, 'a dead peer is stood down, not left "Connected"')
})

test('[REL-45] control: on Linux AmneziaWG\'s userspace device has no age to read, and is not asked', async (t) => {
  const h = linux.fresh({
    fakes: {
      'nodes/node-tester': { fetchNodeServiceType: async () => 'amneziawg' },
      'helper/daemon-client': { daemonWireguardHandshakeAge: async () => 400 },
    },
  })
  t.after(() => h.dispose())
  await connect(h, 'amneziawg')
  await h.advance(15_000 * 4)
  assert.deepEqual(staleHandshake(h), [])
  assert.equal(h.tunnel.up, true)
})
