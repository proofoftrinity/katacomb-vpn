import { test } from 'node:test'
import assert from 'node:assert/strict'
import { versionSignsReplies } from './node-signing.ts'

test('[NT-4] dvpnd 9.4.0 and later sign; everything before, and anything unreadable, does not', () => {
  for (const v of ['9.4.0', '9.4.1', '9.10.0', '10.0.0', 'v9.4.0', '9.4.0-3-gabc1234']) {
    assert.equal(versionSignsReplies(v), true, v)
  }
  // 9.0.0 is what sentinel-dvpnx reports; 9.3.x is dvpnd before signing.
  for (const v of ['9.0.0', '9.3.2', '9.3.2-38', '8.3.1', '8.3.1-dirt', '', 'unknown', '9.4']) {
    assert.equal(versionSignsReplies(v), false, v)
  }
})
