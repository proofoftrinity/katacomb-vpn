import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadIpcHandlers, type FreshOptions, type IpcHarness } from '../../test/harness/ipc.ts'
import { REQUEST, NODE_WG } from '../../test/harness/requests.ts'

// How a connection ENDS: the kill switch around it, the quota watchdog that ends it,
// quit, the startup heals for a crash, and the tray that must hear about all of it
// (docs/invariants/reliability.md [REL-8], [REL-16], [REL-21], [REL-29..32]).

const ipc = await loadIpcHandlers()

const SAVED = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, nodeAddress: NODE_WG, nodeMoniker: 'node-wg', nodeCountry: 'DE', protocol: 'wireguard', configString: 'cfg-saved', ...extra,
}) as never

const privileged = (h: IpcHarness) => h.calls('helper/privileged', 'runPrivileged').map((c) => (c.args[0] as string[]).join(' '))
const marker = (h: IpcHarness) => existsSync(join(h.world.userData, 'killswitch-armed.state'))
const status = async (h: IpcHarness) => await h.settle(h.invoke('CONNECTION_STATUS')) as {
  state: string; killSwitchFailed?: boolean; expired?: { reason: string; trafficBlocked: boolean }
}

async function connect(h: IpcHarness, req: Record<string, unknown> = REQUEST.CONNECTION_SUBSCRIBE, connectParams: Record<string, unknown> = { protocol: 'wireguard' }): Promise<void> {
  await h.settle(h.invoke('CONNECTION_SUBSCRIBE', req))
  await h.settle(h.invoke('CONNECTION_CONNECT', connectParams))
  assert.equal(h.tunnel.up, true)
}

describe('the kill switch, from the main side', () => {
  test('[REL-8] with no endpoint IP to whitelist it is NOT armed, and the connect says so', async (t) => {
    const h = ipc.fresh({ settings: { killSwitch: true } })
    t.after(() => h.dispose())
    h.tunnel.remoteHost = null
    await connect(h)
    assert.deepEqual(privileged(h).filter((a) => a.startsWith('killswitch-on')), [], 'a DROP-all chain with nothing whitelisted strangles the tunnel itself')
    assert.equal(marker(h), false)
    assert.equal((await status(h)).killSwitchFailed, true)
  })

  test('[REL-8] control: with an endpoint it is armed for exactly that endpoint, marker first', async (t) => {
    const h = ipc.fresh({ settings: { killSwitch: true } })
    t.after(() => h.dispose())
    await connect(h)
    assert.deepEqual(privileged(h).filter((a) => a.startsWith('killswitch-on')), ['killswitch-on sntl0 203.0.113.7'])
    assert.equal(marker(h), true)
  })

  test('[REL-29] a disconnect reverts what the MARKER says is armed, not what the setting says now', async (t) => {
    const h = ipc.fresh({ settings: { killSwitch: true } })
    t.after(() => h.dispose())
    await connect(h)
    // The setting goes off without a reapply (as if the toggle's own disarm failed): the chain is still up.
    writeFileSync(join(h.world.userData, 'settings.json'), JSON.stringify({ killSwitch: false }))
    await h.settle(h.invoke('CONNECTION_DISCONNECT'))
    assert.ok(privileged(h).includes('killswitch-off'))
    assert.equal(marker(h), false)
  })

  test('[REL-29] a clean WireGuard session never touches root on the way down (no prompt on the pkexec path)', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    await connect(h)
    await h.settle(h.invoke('CONNECTION_DISCONNECT'))
    assert.deepEqual(privileged(h), [])
  })
})

describe('[REL-16] the quota watchdog ends a session whose paid time is used', () => {
  const hourly = { ...REQUEST.CONNECTION_SUBSCRIBE, type: 'hours', amount: 1 }

  test('[REL-16] [REL-15] an hourly session is stood down after its hour of tunnel time, and stays down', async (t) => {
    const h = ipc.fresh({ settings: { autoReconnect: true } })
    t.after(() => h.dispose())
    await connect(h, hourly)
    await h.advance(59 * 60_000)
    assert.equal(h.tunnel.up, true, 'not before the hour is used')
    await h.advance(2 * 60_000)
    assert.equal(h.tunnel.up, false)
    const s = await status(h)
    assert.equal(s.state, 'idle')
    assert.equal(s.expired?.reason, 'time')
    assert.ok(h.world.notifications.length > 0, 'the user is told')
    await h.advance(5 * 60_000)
    assert.deepEqual(h.sent('CONNECTION_RECONNECTING'), [], 'never auto-renewed, never reconnected')
  })

  test('[REL-16] the watchdog runs in local-proxy mode too', async (t) => {
    const h = ipc.fresh({ fakes: { 'nodes/node-tester': { fetchNodeServiceType: async () => 'v2ray' } } })
    t.after(() => h.dispose())
    await connect(h, { ...hourly, nodeType: 2, proxyMode: true }, { protocol: 'v2ray', mode: 'proxy' })
    await h.advance(61 * 60_000)
    assert.equal(h.tunnel.up, false)
    assert.equal((await status(h)).expired?.reason, 'time')
  })

  test('[REL-16] after an auto-reconnect the watchdog still watches the same quota', async (t) => {
    const h = ipc.fresh({ settings: { autoReconnect: true }, fakes: { 'chain/chain-service': { loadSessionConfig: () => SAVED('1001') } } })
    t.after(() => h.dispose())
    await connect(h, hourly)
    await h.advance(30 * 60_000)
    h.tunnel.down()
    await h.advance(5_000 + 3_000)
    assert.equal(h.tunnel.up, true, 'the reconnect brought it back')
    await h.advance(32 * 60_000)
    assert.equal(h.tunnel.up, false, 'the hour counts across the reconnect')
    assert.equal((await status(h)).expired?.reason, 'time')
  })

  test('[REL-16] the kill-switch setting decides whether traffic stays blocked after expiry', async (t) => {
    const h = ipc.fresh({ settings: { killSwitch: true } })
    t.after(() => h.dispose())
    await connect(h, hourly)
    await h.advance(61 * 60_000)
    assert.equal(h.tunnel.up, false)
    assert.equal(marker(h), true, 'the DROP-all chain stays armed: the user asked for no traffic without a tunnel')
    assert.equal((await status(h)).expired?.trafficBlocked, true)
  })
})

test('[REL-21] with auto-reconnect off, a dropped tunnel is stood down, not left half-alive', async (t) => {
  const h = ipc.fresh({})
  t.after(() => h.dispose())
  await connect(h)
  await h.advance(10 * 60_000)
  h.tunnel.down()
  await h.advance(5_000)
  assert.deepEqual(h.sent('CONNECTION_RECONNECTING'), [])
  assert.equal((await status(h)).expired?.reason, 'dropped')
  const usage = JSON.parse(readFileSync(join(h.world.userData, 'session-usage.json'), 'utf-8')) as Record<string, { durationSeconds: number }>
  const used = usage['1001'].durationSeconds
  await h.advance(10 * 60_000)
  const later = JSON.parse(readFileSync(join(h.world.userData, 'session-usage.json'), 'utf-8')) as typeof usage
  assert.equal(later['1001'].durationSeconds, used, 'the clock stopped when the tunnel went')
})

test('[REL-20] [REL-17] a tunnel that stops answering is stood down, and usage stops at its last sign of life', async (t) => {
  const h = ipc.fresh({})
  t.after(() => h.dispose())
  await connect(h)
  await h.advance(10 * 60_000) // ten carrying minutes
  h.tunnel.carries = false // traffic still leaves; nothing comes back
  await h.advance(5 * 60_000)
  assert.equal(h.tunnel.up, false)
  assert.equal((await status(h)).expired?.reason, 'stalled')
  const usage = JSON.parse(readFileSync(join(h.world.userData, 'session-usage.json'), 'utf-8')) as Record<string, { durationSeconds: number }>
  const used = usage['1001'].durationSeconds
  assert.ok(used >= 600 && used <= 630, `charged for ${used}s: the dead minutes after the last reply must not count`)
})

describe('[REL-30] quit runs the full disconnect', () => {
  test('[REL-30] quitting mid-session leaves a usage floor for the time used', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    await connect(h)
    await h.advance(10 * 60_000)
    await h.settle(h.main.cleanupOnQuit() as Promise<void>)
    assert.equal(h.tunnel.up, false)
    const usage = JSON.parse(readFileSync(join(h.world.userData, 'session-usage.json'), 'utf-8')) as Record<string, { durationSeconds: number }>
    assert.ok(usage['1001'].durationSeconds >= 600, `remembered ${usage['1001'].durationSeconds}s of a 10-minute session`)
  })

  test('[REL-30] the core exiting under a quit does not schedule a reconnect', async (t) => {
    let exitCb: () => void = () => undefined
    const h = ipc.fresh({ settings: { autoReconnect: true }, fakes: {
      'nodes/node-tester': { fetchNodeServiceType: async () => 'v2ray' },
      'vpn/vpn-manager': {
        onV2RayUnexpectedExit: (cb: () => void) => { exitCb = cb },
        // SIGTERM to the core is what fires the exit callback in the real module.
        disconnect: async () => { h.tunnel.down(); exitCb() },
      },
    } })
    t.after(() => h.dispose())
    await connect(h, { ...REQUEST.CONNECTION_SUBSCRIBE, nodeType: 2 }, { protocol: 'v2ray' })
    await h.settle(h.main.cleanupOnQuit() as Promise<void>)
    await h.advance(120_000)
    assert.deepEqual(h.sent('CONNECTION_RECONNECTING'), [])
    assert.equal(h.tunnel.bringUps, 1)
  })
})

describe('[REL-31] startup heals what a crash left', () => {
  const heal = async (h: IpcHarness) => {
    await h.settle(h.main.healOrphanedTunnel() as Promise<void>)
    await h.settle(h.main.healStrandedKillSwitch() as Promise<void>)
  }

  test('[REL-31] a tunnel that survived with no session behind it is closed, and traffic is not left blocked', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    h.tunnel.bringUp('wireguard') // adopted from the previous run
    writeFileSync(join(h.world.userData, 'killswitch-armed.state'), 'armed\n')
    await heal(h)
    assert.equal(h.tunnel.up, false)
    assert.ok(privileged(h).includes('killswitch-off'))
    assert.equal(marker(h), false)
  })

  test('[REL-31] a kill switch stranded with no tunnel is cleared', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    writeFileSync(join(h.world.userData, 'killswitch-armed.state'), 'armed\n')
    await heal(h)
    assert.deepEqual(privileged(h), ['killswitch-off'])
  })

  test('[REL-31] the kill-switch heal leaves a live tunnel\'s chain alone', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    h.tunnel.bringUp('wireguard') // e.g. the orphan heal kept nothing, and a connect came up first
    writeFileSync(join(h.world.userData, 'killswitch-armed.state'), 'armed\n')
    await h.settle(h.main.healStrandedKillSwitch() as Promise<void>)
    assert.deepEqual(privileged(h), [], 'stripping it would expose a protected tunnel')
    assert.equal(marker(h), true)
  })

  test('[PH-1] a clean launch makes no privileged call at all', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    await heal(h)
    assert.deepEqual(privileged(h), [])
  })
})

describe('[REL-32] every teardown tells the tray', () => {
  const listen = (h: IpcHarness) => {
    const states: string[] = []
    ;(h.main.onConnectionStateChanged as (cb: (i: { state: string }) => void) => void)((i) => states.push(i.state))
    return states
  }
  const paths: Array<[string, FreshOptions, (h: IpcHarness) => Promise<void>]> = [
    ['a disconnect', {}, async (h) => { await h.settle(h.invoke('CONNECTION_DISCONNECT')) }],
    ['a quota expiry', {}, async (h) => { await h.advance(61 * 60_000) }],
    ['a dropped tunnel with auto-reconnect off', {}, async (h) => { h.tunnel.down(); await h.advance(5_000) }],
    ['a reconnect that gives up', { settings: { autoReconnect: true }, fakes: { 'chain/chain-service': { loadSessionConfig: () => SAVED('1001') } } },
      async (h) => { h.tunnel.down(); h.tunnel.carries = false; await h.advance(200_000) }],
  ]
  for (const [name, world, end] of paths) {
    test(`[REL-32] ${name}`, async (t) => {
      const h = ipc.fresh(world)
      t.after(() => h.dispose())
      await connect(h, { ...REQUEST.CONNECTION_SUBSCRIBE, type: 'hours', amount: 1 })
      const states = listen(h)
      await end(h)
      assert.equal(h.tunnel.up, false)
      assert.equal(states.at(-1), 'idle', `the tray last heard: ${states.join(', ') || 'nothing'}`)
    })
  }

  test('[REL-32] the orphan heal settles the tray even though it found the tunnel up', async (t) => {
    const h = ipc.fresh({})
    t.after(() => h.dispose())
    h.tunnel.bringUp('wireguard')
    const states = listen(h)
    await h.settle(h.main.healOrphanedTunnel() as Promise<void>)
    assert.equal(states.at(-1), 'idle')
  })
})
