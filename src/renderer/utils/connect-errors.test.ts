import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  displayConnectError,
  isDnsProvisionFailure,
  isInsufficientFunds,
  isRpcUnreachable,
  setupItemsRequired,
} from './connect-errors.ts'
import { DNS_PROVISION_FAILED, INSUFFICIENT_FUNDS, RPC_UNREACHABLE, SYSTEM_SETUP_REQUIRED } from '../../shared/error-markers.ts'

/** Exactly what ipcRenderer.invoke rejects with when a handler throws. */
function viaIpc(channel: string, message: string): string {
  return `Error invoking remote method '${channel}': Error: ${message}`
}

test('the inlined markers have not drifted from the shared ones', () => {
  assert.ok(isDnsProvisionFailure(`${DNS_PROVISION_FAILED}: x`))
  assert.ok(isInsufficientFunds(`${INSUFFICIENT_FUNDS}: x`))
  assert.ok(isRpcUnreachable(`${RPC_UNREACHABLE}: x`))
  assert.deepEqual(setupItemsRequired(`${SYSTEM_SETUP_REQUIRED}:helper: x`), ['helper'])
})

test('markers are detected through the Electron IPC wrapper', () => {
  assert.ok(isRpcUnreachable(viaIpc('connection:subscribe', `${RPC_UNREACHABLE}: Couldn't reach the blockchain`)))
  assert.ok(isInsufficientFunds(viaIpc('connection:subscribe', `${INSUFFICIENT_FUNDS}: You need 50 P2P`)))
  assert.ok(isDnsProvisionFailure(viaIpc('connection:connect', `${DNS_PROVISION_FAILED}: resolvconf missing`)))
})

test('markers are still detected on a bare message', () => {
  assert.ok(isRpcUnreachable(`${RPC_UNREACHABLE}: Couldn't reach the blockchain`))
  assert.ok(isInsufficientFunds(`${INSUFFICIENT_FUNDS}: You need 50 P2P`))
  assert.ok(isDnsProvisionFailure(`${DNS_PROVISION_FAILED}: resolvconf missing`))
})

test('an unrelated failure matches no marker', () => {
  const other = viaIpc('connection:subscribe', 'Bad status on response: 429')
  assert.equal(isRpcUnreachable(other), false)
  assert.equal(isInsufficientFunds(other), false)
  assert.equal(isDnsProvisionFailure(other), false)
})

test('the setup marker carries what the machine lacks, through the IPC wrapper', () => {
  const msg = viaIpc('connection:subscribe', `${SYSTEM_SETUP_REQUIRED}:helper,wireguard-tools: Can't connect, not charged.`)
  assert.deepEqual(setupItemsRequired(msg), ['helper', 'wireguard-tools'])
  assert.deepEqual(setupItemsRequired(`${SYSTEM_SETUP_REQUIRED}:openvpn: x`), ['openvpn'])
})

test('a setup item the renderer has no install for is dropped', () => {
  assert.deepEqual(setupItemsRequired(`${SYSTEM_SETUP_REQUIRED}:helper,kernel-module: x`), ['helper'])
})

test('other failures carry no setup items', () => {
  assert.equal(setupItemsRequired(viaIpc('connection:subscribe', `${INSUFFICIENT_FUNDS}: You need 50 P2P`)), null)
  assert.equal(setupItemsRequired('Node handshake failed'), null)
})

test('displayConnectError strips the setup marker and its payload', () => {
  assert.equal(
    displayConnectError(viaIpc('connection:subscribe', `${SYSTEM_SETUP_REQUIRED}:helper: Can't connect, not charged.`)),
    "Can't connect, not charged.",
  )
})

test('displayConnectError strips the IPC wrapper and the marker', () => {
  assert.equal(
    displayConnectError(viaIpc('connection:subscribe', `${INSUFFICIENT_FUNDS}: You need 50 P2P`)),
    'You need 50 P2P',
  )
  // No marker: the wrapper still goes, so the user reads the cause, not the plumbing.
  assert.equal(
    displayConnectError(viaIpc('connection:subscribe', 'Bad status on response: 429')),
    'Bad status on response: 429',
  )
  // A message that never went through IPC is passed through untouched.
  assert.equal(displayConnectError('Node handshake failed'), 'Node handshake failed')
})
