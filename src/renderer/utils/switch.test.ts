import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectionRelation,
  previousConnection,
  switchFacts,
  switchFooterText,
  switchThenBuy,
} from './switch.ts'
import type { ConnectionStatus } from '../types'

const idle: ConnectionStatus = { state: 'idle' }
const single: ConnectionStatus = {
  state: 'connected', nodeAddress: 'sentnode1a', nodeMoniker: 'Alpha', nodeCountry: 'Albania',
  sessionId: '101', subscriptionId: null,
}
const viaPlan: ConnectionStatus = { ...single, sessionId: '102', subscriptionId: '77' }
const chain: ConnectionStatus = {
  ...single, sessionId: '201',
  chainExit: { sessionId: '202', address: 'sentnode1z', moniker: 'Zulu', country: 'Norway', type: 4 },
}

test('[RN-10] nothing live means no switch', () => {
  assert.equal(connectionRelation(idle, { node: 'sentnode1a' }), 'idle')
  assert.equal(connectionRelation(idle, { subscriptionId: '77' }), 'idle')
  assert.equal(connectionRelation(idle, { entry: 'sentnode1a', exit: 'sentnode1z' }), 'idle')
  assert.equal(previousConnection(idle), null)
})

test('[RN-10] the node, plan or chain already carrying the connection is the same, anything else a switch', () => {
  assert.equal(connectionRelation(single, { node: 'sentnode1a' }), 'same')
  assert.equal(connectionRelation(single, { node: 'sentnode1b' }), 'switch')
  assert.equal(connectionRelation(viaPlan, { subscriptionId: '77' }), 'same')
  assert.equal(connectionRelation(viaPlan, { subscriptionId: '78' }), 'switch')
  // A direct session names no subscription, so no plan is the one serving it.
  assert.equal(connectionRelation(single, { subscriptionId: '77' }), 'switch')
  assert.equal(connectionRelation(chain, { entry: 'sentnode1a', exit: 'sentnode1z' }), 'same')
  assert.equal(connectionRelation(chain, { entry: 'sentnode1a', exit: 'sentnode1y' }), 'switch')
  assert.equal(connectionRelation(single, { entry: 'sentnode1a', exit: 'sentnode1z' }), 'switch')
  // A reconnect blip is still the live connection, not a reason to sell it again.
  assert.equal(connectionRelation({ ...single, state: 'reconnecting' }, { node: 'sentnode1a' }), 'same')
})

test('[RN-10] a chain\'s entry, picked as a single hop, is a switch away from the chain', () => {
  assert.equal(connectionRelation(chain, { node: 'sentnode1a' }), 'switch')
  assert.equal(connectionRelation(chain, { subscriptionId: '77' }), 'switch')
})

test('[RN-10] the previous connection names the session to go back to', () => {
  assert.deepEqual(previousConnection(single), { sessionId: '101', label: 'Alpha', chain: false, proxyMode: false })
  assert.deepEqual(previousConnection(chain), {
    sessionId: '201', label: 'your chain (Alpha → Zulu)', chain: true, proxyMode: false,
  })
  assert.equal(previousConnection({ ...single, nodeMoniker: '', nodeCountry: '' })?.label, 'your current node')
  assert.equal(previousConnection({ ...single, proxyMode: true })?.proxyMode, true)
})

test('[RN-10] a switch leaves before it buys', async () => {
  const calls: string[] = []
  const value = await switchThenBuy({
    leave: async () => { calls.push('leave') },
    onLeft: () => { calls.push('left') },
    purchase: async () => { calls.push('purchase'); return 'session' },
  })
  assert.equal(value, 'session')
  assert.deepEqual(calls, ['leave', 'left', 'purchase'])
})

test('[RN-10] a switch whose leave failed never buys', async () => {
  const calls: string[] = []
  const err = await switchThenBuy({
    leave: async () => { calls.push('leave'); throw new Error('disconnect failed') },
    onLeft: () => { calls.push('left') },
    purchase: async () => { calls.push('purchase'); return 'session' },
  }).then(() => null, (e: Error) => e)
  assert.equal(err?.message, 'disconnect failed')
  // No purchase, and nothing to go back to: the old connection is still up.
  assert.deepEqual(calls, ['leave'])
})

test('[RN-10] a failed purchase after the leave leaves the way back offered', async () => {
  const calls: string[] = []
  const err = await switchThenBuy({
    leave: async () => { calls.push('leave') },
    onLeft: () => { calls.push('left') },
    purchase: async () => { calls.push('purchase'); throw new Error('handshake failed') },
  }).then(() => null, (e: Error) => e)
  assert.equal(err?.message, 'handshake failed')
  assert.deepEqual(calls, ['leave', 'left', 'purchase'])
})

test('[RN-10] with nothing live, the purchase runs alone', async () => {
  const calls: string[] = []
  await switchThenBuy({
    leave: null,
    onLeft: () => { calls.push('left') },
    purchase: async () => { calls.push('purchase') },
  })
  assert.deepEqual(calls, ['purchase'])
})

test('[RN-10] the switch row says the gap, the kill switch and the session left open', () => {
  const prev = previousConnection(single)!
  const on = switchFacts(prev, true)
  assert.equal(on.text, 'Switches from Alpha')
  assert.match(on.lines[0], /apps reach the internet directly, and the kill switch is off\./)
  assert.match(on.lines[1], /^Session #101 stays open/)
  assert.doesNotMatch(switchFacts(prev, false).lines[0], /kill switch/)
  // Proxy mode never touched routing and has no kill switch, so it claims neither.
  const proxy = switchFacts({ ...prev, proxyMode: true }, true)
  assert.doesNotMatch(proxy.lines[0], /kill switch|directly/)
  assert.match(switchFacts(previousConnection(chain)!, false).lines[1], /^Both sessions of your chain stay open/)
  assert.equal(switchFooterText(prev), 'Disconnects from Alpha first. Its session stays open.')
  // No em dashes in anything the user reads (docs/renderer.md).
  for (const s of [on.text, ...on.lines, on.tip, proxy.tip, switchFooterText(prev)]) assert.doesNotMatch(s, /—/)
})
