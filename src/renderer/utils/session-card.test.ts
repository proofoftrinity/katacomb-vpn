import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardState, chainUsage, flooredUsage, quotaUsedUp, usageReading, type SessionUsage } from './session-card.ts'

const row = (o: Partial<{ downloadBytes: string; uploadBytes: string; durationSeconds: number | null }> = {}) =>
  ({ downloadBytes: '0', uploadBytes: '0', durationSeconds: 0, ...o })
const T = Date.parse('2026-10-07T12:00:00Z')

test('[RN-2] a session\'s gauges never go backwards when the live meter vanishes before the chain catches up', () => {
  // Connected 8 minutes over a chain baseline of 3: the card reads 8m.
  const live = usageReading(row({ durationSeconds: 180, downloadBytes: '1000' }), { rxBytes: 5000, txBytes: 100, connectedAt: T - 300_000 }, T)
  assert.equal(live.seconds, 480)
  // The tunnel goes down; the next status poll drops the live half, and the chain row
  // carrying main's remembered figure is still a round-trip behind.
  const gap = usageReading(row({ durationSeconds: 180, downloadBytes: '1000' }), null, T + 3000)
  const shown = flooredUsage(gap, live)
  assert.deepEqual(shown, live, 'the card holds 8m and its bytes instead of dropping to 3m')
  // And it still rises when the truth does.
  assert.equal(flooredUsage({ ...gap, seconds: 600 }, shown).seconds, 600)
})

test('[RN-2] time is metered, not wall-clock: a session bought and never connected shows no time used', () => {
  assert.equal(usageReading(row({ durationSeconds: 0 }), null, T).seconds, 0)
  assert.equal(usageReading(row({ durationSeconds: null }), null, T).seconds, 0)
})

test('the live meter counts only once the status poll reports when the tunnel came up', () => {
  assert.equal(usageReading(row(), { rxBytes: 10, txBytes: 1, connectedAt: null }, T).seconds, 0)
  assert.equal(usageReading(row(), { rxBytes: 10, txBytes: 1, connectedAt: T + 5000 }, T).seconds, 0, 'never negative')
})

test('a chain card is scored off whichever hop is further along', () => {
  const entry: SessionUsage = { downloadBytes: 100, uploadBytes: 50, seconds: 900 }
  const exit: SessionUsage = { downloadBytes: 120, uploadBytes: 40, seconds: 800 }
  assert.deepEqual(chainUsage(entry, exit), { downloadBytes: 120, uploadBytes: 50, seconds: 900 })
  assert.deepEqual(chainUsage(entry, null), entry)
})

test('[REL-24] Connect is withheld once the paid time or data is used, though the chain still says active', () => {
  const hourly = { maxBytes: '0', maxDurationSeconds: 3600 }
  const use = (seconds: number, downloadBytes = 0): SessionUsage => ({ downloadBytes, uploadBytes: 0, seconds })
  assert.equal(quotaUsedUp(hourly, use(3599)), false)
  assert.equal(quotaUsedUp(hourly, use(3600)), true)
  assert.equal(quotaUsedUp(hourly, use(5673)), true, '#53647217: metered past the cap, still status 1')
  const perGb = { maxBytes: String(1024 ** 3), maxDurationSeconds: null }
  assert.equal(quotaUsedUp(perGb, use(99_999, 1024 ** 3 - 1)), false, 'a data session is not ended by time')
  assert.equal(quotaUsedUp(perGb, use(0, 1024 ** 3)), true)
  assert.equal(quotaUsedUp({ maxBytes: '0', maxDurationSeconds: null }, use(1e9, 1e12)), false, 'no cap, nothing to use up')
})

test('[MH-10] a chain that has lost a hop is broken, not ended: its open hop can still be ended', () => {
  const active = { status: 'active', chainPeerSessionId: 'x' }
  const pending = { status: 'inactive_pending', chainPeerSessionId: 'x' }
  assert.equal(cardState(active, active), 'open')
  assert.equal(cardState(active, pending), 'broken')
  assert.equal(cardState(pending, active), 'broken')
  assert.equal(cardState(pending, pending), 'ended')
  assert.equal(cardState(active, null), 'broken', 'a lone hop whose partner already left the list')
  assert.equal(cardState({ status: 'active' }, null), 'open', 'an ordinary single-hop session')
  assert.equal(cardState({ ...active, chainPeerEndedByUser: true }, pending), 'ending', 'the user\'s own End, half done')
})
