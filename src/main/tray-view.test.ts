import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markedTrayBitmap, TRAY_HOST_ATTEMPTS, TRAY_HOST_INTERVAL_MS, TRAY_REPAINT_AGAIN_MS, trayPainter, trayView, waitForTrayHost } from './tray-view.ts'
import type { ConnectionInfo } from './ipc-handlers.ts'

// What the tray draws for each connection state: icon, the disabled status rows at the
// top of its menu, the one action it offers and the Quit label. index.ts only hands
// this to Electron, so this table is the tray's whole behaviour.

const idle: ConnectionInfo = { state: 'idle', blocked: false, proxyMode: false, killSwitchFailed: false }
const up: ConnectionInfo = { ...idle, state: 'connected', nodeMoniker: 'node-wg' }

test('[REL-38] idle: the outline K, and the one action reconnects the session main chose', () => {
  assert.deepEqual(trayView({ ...idle, reconnectSessionId: '2001' }), {
    icon: 'disconnected',
    tooltip: 'Katacomb VPN: Disconnected',
    statusLines: ['Disconnected'],
    action: { label: 'Reconnect last session', run: 'reconnect', sessionId: '2001' },
    quitLabel: 'Quit',
  })
})

test('[REL-38] idle with no session main would reconnect: no action at all', () => {
  assert.deepEqual(trayView(idle), {
    icon: 'disconnected',
    tooltip: 'Katacomb VPN: Disconnected',
    statusLines: ['Disconnected'],
    action: null,
    quitLabel: 'Quit',
  })
})

test('[REL-35] traffic blocked by the kill switch is its own state, and offers Restore internet', () => {
  assert.deepEqual(trayView({ ...idle, blocked: true }), {
    icon: 'blocked',
    tooltip: 'Katacomb VPN: Internet blocked by the kill switch',
    statusLines: ['Internet blocked by the kill switch'],
    action: { label: 'Restore internet', run: 'disconnect' },
    quitLabel: 'Quit',
  })
})

test('[REL-35] connecting offers no action: a second connect or a racing disconnect would land mid-payment', () => {
  const view = trayView({ ...idle, state: 'connecting', nodeMoniker: 'node-wg' })
  assert.deepEqual([view.icon, view.statusLines, view.action, view.quitLabel], ['connecting', ['Connecting to node-wg…'], null, 'Quit'])
  assert.deepEqual(trayView({ ...idle, state: 'connecting' }).statusLines, ['Connecting…'], 'a node not known yet is not guessed')
})

test('reconnecting: the connecting K, the attempt, and Disconnect stops the ladder', () => {
  const view = trayView({ ...idle, state: 'reconnecting', nodeMoniker: 'node-wg', reconnectAttempt: 2, reconnectMaxAttempts: 5 })
  assert.deepEqual(view, {
    icon: 'connecting',
    tooltip: 'Katacomb VPN: Reconnecting to node-wg (2 of 5)',
    statusLines: ['Reconnecting to node-wg (2 of 5)'],
    action: { label: 'Disconnect', run: 'disconnect' },
    quitLabel: 'Disconnect and quit',
  })
})

test('connected: the solid K, the node, Disconnect, and Quit says it disconnects', () => {
  assert.deepEqual(trayView(up), {
    icon: 'connected',
    tooltip: 'Katacomb VPN: Connected to node-wg',
    statusLines: ['Connected to node-wg'],
    action: { label: 'Disconnect', run: 'disconnect' },
    quitLabel: 'Disconnect and quit',
  })
  assert.deepEqual(trayView({ ...up, nodeMoniker: undefined }).statusLines, ['Connected'])
})

test('a chain names the exit first, where the traffic appears to come from, then the entry', () => {
  assert.deepEqual(trayView({ ...up, nodeMoniker: 'tokyo', entryMoniker: 'amsterdam' }).statusLines, ['Connected to tokyo', 'via amsterdam'])
})

test('local-proxy mode says nothing but the SOCKS5 listener is routed', () => {
  assert.deepEqual(trayView({ ...up, proxyMode: true, socksAddr: '127.0.0.1:1080' }).statusLines, ['Connected to node-wg', 'Proxy only: SOCKS5 127.0.0.1:1080'])
  assert.deepEqual(trayView({ ...up, proxyMode: true }).statusLines, ['Connected to node-wg', 'Proxy only (SOCKS5)'])
})

test('a kill switch that failed to arm is said, not hidden behind the green K', () => {
  assert.deepEqual(trayView({ ...up, killSwitchFailed: true }).statusLines, ['Connected to node-wg', '⚠ Kill switch inactive'])
})

test('control: blocked means nothing outside idle', () => {
  assert.equal(trayView({ ...up, blocked: true }).icon, 'connected')
})

// [REL-39] Reproduced on Cinnamon: with the app's main thread busy for 6.5 s right after
// it painted the green K, the panel's fetch of the new image timed out and the amber K
// stayed up for good.

test('[REL-39] every repaint is sent again, marked, so a panel that dropped it catches up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const painted: [string, boolean][] = []
  const paint = trayPainter((key, marked) => painted.push([key, marked]))
  paint('connected-dark')
  assert.deepEqual(painted, [['connected-dark', false]])
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS - 1)
  assert.equal(painted.length, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(painted, [['connected-dark', false], ['connected-dark', true]])
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS * 10)
  assert.equal(painted.length, 2, 'once again, not a repaint loop')
})

test('[REL-39] a newer repaint replaces the pending one: the second send is the latest icon', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const painted: [string, boolean][] = []
  const paint = trayPainter((key, marked) => painted.push([key, marked]))
  paint('connecting-dark')
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS / 2)
  paint('connected-dark')
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS)
  assert.deepEqual(painted, [['connecting-dark', false], ['connected-dark', false], ['connected-dark', true]])
})

test('[REL-39] the marked bitmap differs by one alpha step mid-image, and nowhere else', () => {
  const plain = Buffer.alloc(32 * 32 * 4)
  plain.fill(0xff, 4 * 40, 4 * 60) // some opaque pixels elsewhere
  const before = Buffer.from(plain)
  const marked = markedTrayBitmap(plain, { width: 32, height: 32 })
  assert.deepEqual(plain, before, 'the source bitmap is left alone')
  const diffs = [...marked.keys()].filter((i) => marked[i] !== plain[i])
  assert.deepEqual(diffs, [16 * 32 * 4 + 3], 'only the alpha of the middle row’s leftmost pixel changes')
  assert.equal(marked[diffs[0]], 1, 'from fully transparent to 1 of 255')
  // Live on Cinnamon, a mark in the top-left pixel never reached the panel: it checksums
  // the buffer after freeing it, and the allocator writes over both ends.
  assert.ok(diffs[0] >= 64 && diffs[0] < plain.length - 64, 'the mark must sit clear of both ends of the buffer')
})

/** A probe that answers from a script, counting the questions; then a no for ever. */
function scriptedProbe(answers: boolean[]) {
  const probe = { asked: 0, ask: async () => answers[probe.asked++] ?? false }
  return probe
}
/** Let the awaited probe and the loop behind it run (setImmediate is not mocked). */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('[REL-40] a login start asks again while the panel comes up, and stops at the first yes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = scriptedProbe([false, false, true])
  const answer = waitForTrayHost(probe.ask)
  await flush()
  assert.equal(probe.asked, 1)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS - 1)
  await flush()
  assert.equal(probe.asked, 1, 'not asked again before the interval')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(probe.asked, 2)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS)
  await flush()
  assert.equal(await answer, true)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS * 10)
  await flush()
  assert.equal(probe.asked, 3, 'nothing is asked after the yes')
})

test('[REL-40] with no tray host it answers no after the last attempt, so the window opens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = scriptedProbe([])
  let settled: boolean | undefined
  void waitForTrayHost(probe.ask).then((v) => { settled = v })
  for (let i = 1; i < TRAY_HOST_ATTEMPTS; i++) {
    await flush()
    assert.equal(settled, undefined, `still waiting after ${i} of ${TRAY_HOST_ATTEMPTS}`)
    t.mock.timers.tick(TRAY_HOST_INTERVAL_MS)
  }
  await flush()
  assert.equal(settled, false)
  assert.equal(probe.asked, TRAY_HOST_ATTEMPTS)
})

test('[REL-40] a tray that is already up answers at once, with no wait', async () => {
  const probe = scriptedProbe([true])
  assert.equal(await waitForTrayHost(probe.ask), true)
  assert.equal(probe.asked, 1)
})
