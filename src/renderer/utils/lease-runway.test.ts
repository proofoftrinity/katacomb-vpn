import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leaseRunway, leaseStopsSoon } from './lease-runway.ts'

test('leaseRunway: soonest end first, on one axis that fits the longest', () => {
  const { rows, axisHours } = leaseRunway([
    { id: 'a', hours: 18, maxHours: 24 },
    { id: 'b', hours: 40, maxHours: 168 },
    { id: 'c', hours: 21, maxHours: 24 },
  ])
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a', 'b'])
  assert.deepEqual(rows.map((r) => r.hoursLeft), [3, 6, 128])
  assert.equal(axisHours, 168)
  assert.equal(rows[2].fraction, 128 / 168)
})

test('leaseRunway: an exhausted lease is not on the runway', () => {
  const { rows } = leaseRunway([{ id: 'done', hours: 24, maxHours: 24 }, { id: 'live', hours: 1, maxHours: 24 }])
  assert.deepEqual(rows.map((r) => r.id), ['live'])
})

test('leaseRunway: past thirty days the axis is the longest lease itself', () => {
  const { axisHours } = leaseRunway([{ hours: 0, maxHours: 1000 }])
  assert.equal(axisHours, 1000)
})

test('leaseRunway: no leases, no rows', () => {
  assert.deepEqual(leaseRunway([]), { rows: [], axisHours: 24 })
})

test('leaseStopsSoon: the soonest never-renew lease under a day; renewing ones do not count', () => {
  const s = leaseStopsSoon([
    { id: 'renews', hours: 23, maxHours: 24, renewalPricePolicy: 7 },
    { id: 'a-day', hours: 0, maxHours: 24, renewalPricePolicy: 0 },
    { id: 'soon', hours: 21, maxHours: 24, renewalPricePolicy: 0 },
    { id: 'sooner', hours: 23, maxHours: 24, renewalPricePolicy: 0 },
    { id: 'done', hours: 24, maxHours: 24, renewalPricePolicy: 0 },
  ])
  assert.equal(s?.id, 'sooner')
  assert.equal(s?.hoursLeft, 1)
})

test('leaseStopsSoon: nothing ending within a day is null', () => {
  assert.equal(leaseStopsSoon([{ hours: 0, maxHours: 24, renewalPricePolicy: 0 }]), null)
  assert.equal(leaseStopsSoon([]), null)
})
