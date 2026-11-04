import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeSoftware, versionSignsReplies } from './node-signing.ts'

test('[NT-4] dvpnd 9.4.0 and later sign; everything before, and anything unreadable, does not', () => {
  for (const v of ['9.4.0', '9.4.1', '9.10.0', '10.0.0', 'v9.4.0', '9.4.0-3-gabc1234']) {
    assert.equal(versionSignsReplies(v), true, v)
  }
  // 9.0.0 is what sentinel-dvpnx reports; 9.3.x is dvpnd before signing.
  for (const v of ['9.0.0', '9.3.2', '9.3.2-38', '8.3.1', '8.3.1-dirt', '', 'unknown', '9.4']) {
    assert.equal(versionSignsReplies(v), false, v)
  }
})

test('[REL-46] dvpnd names itself, signs from 9.4 and alone is past 9.0; dvpnx is 8.2 to 9.0.0 with no name', () => {
  assert.equal(nodeSoftware({ version: '9.4.3' }), 'dvpnd')
  assert.equal(nodeSoftware({ version: '9.1.0' }), 'dvpnd', 'dvpnx has never reported past 9.0.0')
  assert.equal(nodeSoftware({ version: '9.0.0', name: 'dvpnd' }), 'dvpnd', 'dvpnd forked at 9.0.0, so only its name tells')
  assert.equal(nodeSoftware({ version: '8.3.1', signedReply: true }), 'dvpnd', 'a verified signature outranks the version')
  assert.equal(nodeSoftware({ version: '9.0.0' }), 'dvpnx', 'the directory alone: confirmed later by the root document')
  assert.equal(nodeSoftware({ version: '9.0.0', name: '' }), 'dvpnx')
  assert.equal(nodeSoftware({ version: '8.2.0', name: '' }), 'dvpnx')
  assert.equal(nodeSoftware({ version: '9.0.0', name: 'othernode' }), null, 'another implementation was never read')
  assert.equal(nodeSoftware({ version: '8.1.9' }), null, 'older than anything read')
  assert.equal(nodeSoftware({ version: '' }), null)
})
