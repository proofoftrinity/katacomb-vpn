import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareToNodes, dataUsed, decadeScale, nodeMedianPerGb, timeUsed } from './plan-value.ts'

const node = (gb: string | null, healthy = true, active = true) => ({
  isActive: active,
  isHealthy: healthy,
  gigabytePrices: gb === null ? [] : [{ denom: 'udvpn', value: gb }],
})

test('nodeMedianPerGb: the median of healthy, active, udvpn-priced nodes, in P2P', () => {
  const nodes = [node('40000000'), node('30000000'), node('50000000'), node('1', false), node(null)]
  assert.equal(nodeMedianPerGb(nodes), 40)
})

test('nodeMedianPerGb: an even count averages the middle pair; nothing priced is null', () => {
  assert.equal(nodeMedianPerGb([node('30000000'), node('40000000')]), 35)
  assert.equal(nodeMedianPerGb([node(null), node('40000000', false)]), null)
})

test('decadeScale: covers every value in whole decades and places them by log', () => {
  const s = decadeScale([0.0002, 10, 80])
  assert.deepEqual(s.ticks, [-4, -3, -2, -1, 0, 1, 2])
  assert.equal(s.at(0.0001), 0)
  assert.equal(s.at(100), 100)
  assert.equal(Math.round(s.at(10)), 83)
})

test('decadeScale: a single value still gets a readable span around it', () => {
  const s = decadeScale([10])
  assert.ok(s.ticks.length >= 3)
  assert.ok(s.at(10) > 0 && s.at(10) < 100)
})

test('compareToNodes: 10 P2P/GB against a 40 median is 4x cheaper', () => {
  assert.deepEqual(compareToNodes(10, 40), { kind: 'cheaper', factor: 4 })
  assert.equal(compareToNodes(80, 40).kind, 'dearer')
  assert.equal(compareToNodes(80, 40).factor, 2)
  assert.equal(compareToNodes(35, 40).kind, 'same')
})

test('timeUsed: 12 days into a 30 day subscription', () => {
  const start = '2026-10-01T00:00:00Z'
  const end = '2026-10-31T00:00:00Z'
  const t = timeUsed(start, end, Date.parse('2026-10-13T00:00:00Z'))
  assert.ok(t)
  assert.equal(t.totalDays, 30)
  assert.equal(t.usedDays, 12)
  assert.equal(t.leftDays, 18)
  assert.equal(t.fraction, 0.4)
})

test('timeUsed: clamps past the end, and missing dates give no gauge', () => {
  const t = timeUsed('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', Date.parse('2026-10-05T00:00:00Z'))
  assert.equal(t?.fraction, 1)
  assert.equal(t?.leftDays, 0)
  assert.equal(timeUsed(null, '2026-10-02T00:00:00Z', 0), null)
  assert.equal(timeUsed('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z', 0), null)
})

test('dataUsed: 25 GB of a 100 GB allocation is a quarter', () => {
  assert.deepEqual(dataUsed('100000000000', '25000000000', 1e15),
    { fraction: 0.25, granted: 1e11, utilised: 2.5e10, unlimited: false })
})

test('dataUsed: an unlimited grant has no fraction to draw', () => {
  // Subscription 1942322 on plan #41, read live on 2026-10-06.
  const u = dataUsed('9000000000000000000', '560', 1e15)
  assert.equal(u?.unlimited, true)
  assert.equal(u?.utilised, 560)
})

test('dataUsed: overuse clamps, a zero grant is used up, garbage is null', () => {
  assert.equal(dataUsed('1000', '5000', 1e15)?.fraction, 1)
  assert.equal(dataUsed('0', '0', 1e15)?.fraction, 1)
  assert.equal(dataUsed('', 'x', 1e15), null)
  assert.equal(dataUsed('-1', '0', 1e15), null)
})
