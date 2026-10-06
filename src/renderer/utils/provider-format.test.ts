import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usdEstimate } from './provider-format.ts'

// The live rate when the bug was reported: 25,974.03 P2P was about $2.05.
const RATE = 0.0000789

test('usdEstimate: a sub-cent amount below $0.0001 never prints an exponent', () => {
  // A 24 hour lease on a 0.0001 P2P/h node: 2400 udvpn. toPrecision gave "$1.9e-7".
  const s = usdEstimate(2400, RATE)
  assert.equal(s, 'under $0.0001')
  assert.doesNotMatch(s, /e-/)
})

test('usdEstimate: sub-cent amounts keep two significant digits, in plain decimals', () => {
  // 0.135135 P2P/h for 24 hours: 3.24 P2P, about $0.00026.
  assert.equal(usdEstimate(3_243_240, RATE), 'about $0.00026')
})

test('usdEstimate: a cent or more rounds to cents', () => {
  assert.equal(usdEstimate(25_974_030_000, RATE), 'about $2.05')
  assert.equal(usdEstimate('100000000000', RATE), 'about $7.89')
})

test('usdEstimate: zero is exact, and unreadable input says nothing', () => {
  assert.equal(usdEstimate(0, RATE), '$0.00')
  assert.equal(usdEstimate('not a number', RATE), '')
})
