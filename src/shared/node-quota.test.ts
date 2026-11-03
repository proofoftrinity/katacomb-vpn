import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveCaps, nodeClockSeconds, paidTimeEndsAtMs, type NodeCaps } from './node-quota.ts'

const T = Date.parse('2026-11-04T12:00:00Z')
const caps = (o: Partial<NodeCaps> = {}): NodeCaps =>
  ({ maxBytes: 0, maxDurationSeconds: 3600, handshakeAtMs: T, durationAtHandshakeSeconds: 0, ...o })

test('[SL-6] a renewed plan is scored against what the node took at the handshake, not the grown chain caps', () => {
  // The renewal doubled the chain's figures for the same session; the node never saw it.
  assert.deepEqual(
    effectiveCaps({ maxBytes: 20e9, maxDurationSeconds: 2 * 2_592_000 }, caps({ maxBytes: 10e9, maxDurationSeconds: 2_592_000 })),
    { maxBytes: 10e9, maxDurationSeconds: 2_592_000 },
  )
  // The other way round, the chain's smaller figure wins: it is what the chain settles.
  assert.deepEqual(
    effectiveCaps({ maxBytes: 4e9, maxDurationSeconds: 3600 }, caps({ maxBytes: 10e9, maxDurationSeconds: 7200 })),
    { maxBytes: 4e9, maxDurationSeconds: 3600 },
  )
})

test('effectiveCaps: no recorded handshake keeps the chain caps, and a missing cap stays missing', () => {
  assert.deepEqual(effectiveCaps({ maxBytes: 1e9, maxDurationSeconds: null }, undefined), { maxBytes: 1e9, maxDurationSeconds: null })
  assert.deepEqual(
    effectiveCaps({ maxBytes: 1e9, maxDurationSeconds: null }, caps({ maxBytes: 1e9, maxDurationSeconds: 0 })),
    { maxBytes: 1e9, maxDurationSeconds: null },
  )
  assert.deepEqual(
    effectiveCaps({ maxBytes: 0, maxDurationSeconds: 3600 }, caps({ maxBytes: 0, maxDurationSeconds: 3600 })),
    { maxBytes: 0, maxDurationSeconds: 3600 },
  )
})

test('[SL-6] the node clock runs from the handshake, gaps included', () => {
  // Ten minutes connected, half an hour away: the node reads 40 minutes at the next activity.
  assert.equal(nodeClockSeconds(caps(), T + 40 * 60_000), 2400)
  // It starts from what the chain had already metered when the node admitted the session.
  assert.equal(nodeClockSeconds(caps({ durationAtHandshakeSeconds: 600 }), T + 60_000), 660)
  assert.equal(nodeClockSeconds(caps(), T - 5000), 0, 'never before the handshake')
})

test('[SL-6] the paid time ends where the node clock reaches the cap', () => {
  assert.equal(paidTimeEndsAtMs(caps(), 3600), T + 3_600_000)
  assert.equal(paidTimeEndsAtMs(caps({ durationAtHandshakeSeconds: 600 }), 3600), T + 3_000_000)
  assert.equal(nodeClockSeconds(caps(), paidTimeEndsAtMs(caps(), 3600)), 3600)
})
