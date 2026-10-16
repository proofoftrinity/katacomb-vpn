import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeStatusMeta, nodeStatusRank, isNodeConnectable, hasDirectoryDetails } from './node-status.ts'

// The real shapes the node-list API returns, one per observed combination.
const HEALTHY = { isActive: true, isHealthy: true, errorMessage: null, type: 1 }
const UNHEALTHY = { isActive: true, isHealthy: false, errorMessage: 'VPN connect failed', type: 1 }
const INACTIVE = { isActive: false, isHealthy: false, errorMessage: 'Inactive node', type: 1 }
// A node the directory never read (empty api, moniker and location, fetchedAt null),
// still flagged active, healthy and whitelisted: 139 such rows on 2026-10-16.
const NO_DETAILS = { isActive: true, isHealthy: true, errorMessage: null, type: 0 }

test('an active node failing the health check is NOT labelled Inactive', () => {
  const meta = nodeStatusMeta(UNHEALTHY)
  assert.equal(meta.state, 'unhealthy')
  assert.equal(meta.label, 'Unhealthy')
  assert.notEqual(meta.label, 'Inactive')
  // The reason the aggregator gave must reach the user.
  assert.match(meta.detail, /VPN connect failed/)
  assert.match(meta.detail, /Active on-chain/)
})

test('the three states get three distinct labels and dots', () => {
  const labels = [HEALTHY, UNHEALTHY, INACTIVE].map((n) => nodeStatusMeta(n).label)
  assert.deepEqual(labels, ['Active', 'Unhealthy', 'Inactive'])
  const dots = [HEALTHY, UNHEALTHY, INACTIVE].map((n) => nodeStatusMeta(n).dotClass)
  assert.deepEqual(new Set(dots).size, 3)
})

test('an inactive node does not repeat the redundant upstream message', () => {
  const meta = nodeStatusMeta(INACTIVE)
  assert.equal(meta.state, 'inactive')
  assert.doesNotMatch(meta.detail, /Inactive node/)
})

test('a missing health reason still yields a complete sentence', () => {
  const meta = nodeStatusMeta({ isActive: true, isHealthy: false, errorMessage: null, type: 1 })
  assert.equal(meta.state, 'unhealthy')
  assert.match(meta.detail, /health check failed\.$/)
  // An all-whitespace message is treated as absent, not interpolated raw.
  assert.match(nodeStatusMeta({ ...UNHEALTHY, errorMessage: '   ' }).detail, /health check failed\.$/)
})

test('rank orders healthy > unhealthy > inactive', () => {
  assert.ok(nodeStatusRank(HEALTHY) > nodeStatusRank(UNHEALTHY))
  assert.ok(nodeStatusRank(UNHEALTHY) > nodeStatusRank(INACTIVE))
})

test('only a node passing both checks is connectable', () => {
  assert.equal(isNodeConnectable(HEALTHY), true)
  assert.equal(isNodeConnectable(UNHEALTHY), false)
  assert.equal(isNodeConnectable(INACTIVE), false)
  // An unregistered node is never connectable, even if flagged healthy.
  assert.equal(isNodeConnectable({ isActive: false, isHealthy: true, errorMessage: null, type: 1 }), false)
})

test('[RN-14] a node the directory has no details for is "No details", not Active, and not connectable', () => {
  const meta = nodeStatusMeta(NO_DETAILS)
  assert.equal(meta.state, 'no-details')
  assert.equal(meta.label, 'No details')
  assert.match(meta.detail, /no details/)
  assert.equal(isNodeConnectable(NO_DETAILS), false)
  assert.equal(hasDirectoryDetails(NO_DETAILS), false)
  // Positive control: the same record once the directory knows its protocol.
  const known = { ...NO_DETAILS, type: 1 }
  assert.equal(nodeStatusMeta(known).state, 'active')
  assert.equal(isNodeConnectable(known), true)
  assert.equal(hasDirectoryDetails(known), true)
})

test('[RN-14] a blank node failing the health check is "No details" too: there is nothing to try anyway', () => {
  assert.equal(nodeStatusMeta({ ...NO_DETAILS, isHealthy: false, errorMessage: 'VPN connect failed' }).state, 'no-details')
  // Inactive on chain still outranks it.
  assert.equal(nodeStatusMeta({ ...NO_DETAILS, isActive: false }).state, 'inactive')
})

test('[RN-14] rank orders healthy > unhealthy > no details > inactive', () => {
  assert.ok(nodeStatusRank(HEALTHY) > nodeStatusRank(UNHEALTHY))
  assert.ok(nodeStatusRank(UNHEALTHY) > nodeStatusRank(NO_DETAILS))
  assert.ok(nodeStatusRank(NO_DETAILS) > nodeStatusRank(INACTIVE))
})
