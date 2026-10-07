import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule } from '../../../test/harness/module.ts'
import { LAN_SHARING_ARG } from '../config-guard.ts'

// The kill switch's marker is what every teardown and the startup heal read to decide
// whether a DROP-all chain may be installed (reliability.md [REL-29], [REL-31]). It
// must be written BEFORE arming and cleared only after a confirmed teardown, or a
// crash between the two leaves a chain nothing knows to remove.

const ks = await loadModule({ entries: ['src/main/vpn/kill-switch.ts'], fake: ['src/main/helper/privileged'] })

type Fn = (...a: unknown[]) => Promise<unknown>

test('[REL-31] the marker is on disk before the chain is armed, so a crash mid-arm is still healed', async (t) => {
  let markerDuringArm = false
  const h = ks.fresh({ 'helper/privileged': { runPrivileged: async () => { markerDuringArm = existsSync(join(h.world.userData, 'killswitch-armed.state')) } } })
  t.after(() => h.dispose())
  await (h.mod.enableKillSwitch as Fn)('sntl0', '203.0.113.7', {})
  assert.equal(markerDuringArm, true)
})

test('[REL-25] the argv: iface, endpoint, a real resolver only, and the LAN sentinel last', async (t) => {
  const seen: string[][] = []
  const h = ks.fresh({ 'helper/privileged': { runPrivileged: async (a: string[]) => { seen.push(a) } } })
  t.after(() => h.dispose())
  const arm = h.mod.enableKillSwitch as Fn
  await arm('sntl0', '203.0.113.7', {})
  await arm('sntl-tun', '203.0.113.7', { dnsIp: '9.9.9.9', lanSharing: true })
  await arm('sntl0', '203.0.113.7', { dnsIp: 'system', lanSharing: true })
  assert.deepEqual(seen, [
    ['killswitch-on', 'sntl0', '203.0.113.7'],
    ['killswitch-on', 'sntl-tun', '203.0.113.7', '9.9.9.9', LAN_SHARING_ARG],
    ['killswitch-on', 'sntl0', '203.0.113.7', LAN_SHARING_ARG],
  ])
})

test('[REL-31] a confirmed teardown clears the marker; a failed one keeps it for the next launch', async (t) => {
  let fail = false
  const h = ks.fresh({ 'helper/privileged': { runPrivileged: async () => { if (fail) throw new Error('daemon dead') } } })
  t.after(() => h.dispose())
  const marker = join(h.world.userData, 'killswitch-armed.state')
  await (h.mod.enableKillSwitch as Fn)('sntl0', '203.0.113.7', {})
  fail = true
  assert.equal(await (h.mod.disableKillSwitch as Fn)(), false)
  assert.equal(existsSync(marker), true, 'the chain may still be installed')
  fail = false
  assert.equal(await (h.mod.disableKillSwitch as Fn)(), true)
  assert.equal(existsSync(marker), false)
})
