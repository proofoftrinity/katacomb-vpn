import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trayView } from './tray-view.ts'
import type { ConnectionInfo } from './ipc-handlers.ts'

// What the tray draws for each connection state: icon, the disabled status rows at the
// top of its menu, the one action it offers and the Quit label. index.ts only hands
// this to Electron, so this table is the tray's whole behaviour.

const idle: ConnectionInfo = { state: 'idle', blocked: false, proxyMode: false, killSwitchFailed: false }
const up: ConnectionInfo = { ...idle, state: 'connected', nodeMoniker: 'node-wg' }

test('idle: no badge, and the one action says what it reconnects', () => {
  assert.deepEqual(trayView(idle), {
    icon: 'disconnected',
    tooltip: 'Katacomb VPN: Disconnected',
    statusLines: ['Disconnected'],
    action: { label: 'Reconnect last session', run: 'reconnect' },
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

test('reconnecting: amber, the attempt, and Disconnect stops the ladder', () => {
  const view = trayView({ ...idle, state: 'reconnecting', nodeMoniker: 'node-wg', reconnectAttempt: 2, reconnectMaxAttempts: 5 })
  assert.deepEqual(view, {
    icon: 'connecting',
    tooltip: 'Katacomb VPN: Reconnecting to node-wg (2 of 5)',
    statusLines: ['Reconnecting to node-wg (2 of 5)'],
    action: { label: 'Disconnect', run: 'disconnect' },
    quitLabel: 'Disconnect and quit',
  })
})

test('connected: green, the node, Disconnect, and Quit says it disconnects', () => {
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

test('a kill switch that failed to arm is said, not hidden behind the green dot', () => {
  assert.deepEqual(trayView({ ...up, killSwitchFailed: true }).statusLines, ['Connected to node-wg', '⚠ Kill switch inactive'])
})

test('control: blocked means nothing outside idle', () => {
  assert.equal(trayView({ ...up, blocked: true }).icon, 'connected')
})
